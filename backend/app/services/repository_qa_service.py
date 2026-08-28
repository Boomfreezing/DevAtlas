import re
import time
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.analysis import CodeSymbol, ImportRelation
from app.models.project import Project, ProjectFile
from app.services.code_scope_service import classify_code_scope
from app.services.report_provider_service import answer_with_report_provider
from app.services.repository_path_service import resolve_project_storage_path
from app.services.search_service import search_project, tokenize
from app.services.semantic_search_service import (
    semantic_rerank_candidates,
    semantic_search_project,
)


MAX_CITATIONS = 8
MAX_EVIDENCE_CHARS = 1_600
MAX_DIRECT_FILE_BYTES = 512 * 1024
MIN_SEMANTIC_RELEVANCE = 0.42
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_.:/-]{2,}")
GENERIC_IDENTIFIERS = {
    "the", "this", "that", "where", "what", "which", "project", "function",
    "method", "class", "file", "code", "table", "database", "start", "run",
    "change", "impact", "repository", "repo",
}
DATABASE_ENTITY_STOPWORDS = {
    "a", "an", "and", "as", "by", "data", "database", "for", "from", "in",
    "into", "of", "on", "or", "select", "table", "that", "the", "this", "to",
    "update", "where", "with",
}
IDENTIFIER_ALIASES = {
    "登录": ("login", "auth"),
    "鉴权": ("auth", "authorize"),
    "认证": ("auth", "authentication"),
    "用户": ("user",),
    "会话": ("session",),
    "上传": ("upload", "multipart"),
    "下载": ("download",),
    "文件": ("file",),
    "接口": ("api", "route", "endpoint"),
    "配置": ("config", "settings"),
    "环境变量": ("environment", "env"),
    "测试": ("test", "spec"),
    "报错": ("error", "exception"),
    "错误": ("error", "exception"),
    "异常": ("exception", "error"),
    "数据库": ("database", "table"),
    "支付": ("payment", "billing", "checkout"),
    "订单": ("order", "purchase"),
    "权限": ("permission", "role", "access", "authorize"),
    "缓存": ("cache", "redis"),
    "消息": ("message", "event", "queue"),
    "日志": ("log", "logger", "logging"),
    "搜索": ("search", "query", "find"),
    "创建": ("create", "add", "insert"),
    "删除": ("delete", "remove"),
    "保存": ("save", "store", "persist"),
    "读取": ("read", "load", "get", "fetch"),
}
STARTUP_COMMAND_PATTERN = re.compile(
    r"(?:npm|pnpm|yarn)\s+(?:run\s+)?[\w:-]+(?:\s+\S+)*|"
    r"uvicorn\s+[\w.:-]+(?:\s+\S+)*|docker(?:\s+|-)compose\s+\S+(?:\s+\S+)*|"
    r"python(?:3)?\s+(?:-m\s+)?[\w./-]+(?:\s+\S+)*|make\s+[\w.-]+(?:\s+\S+)*|"
    r"bash\s+[\w./-]+(?:\s+\S+)*|source\s+[\w./-]+|"
    r"uv\s+(?:run|sync)\b(?:\s+\S+)*|pipx?\s+install\s+\S+(?:\s+\S+)*|"
    r"git\s+clone\s+\S+(?:\s+\S+)*",
    re.IGNORECASE,
)
STARTUP_HEADING_PATTERN = re.compile(
    r"quick\s*start|getting\s+started|self[- ]hosting|launch\s+(?:the\s+)?service|"
    r"run(?:ning)?\s+(?:the\s+)?project|development\s+setup",
    re.IGNORECASE,
)

INTENT_TERMS = {
    "startup": ("启动", "运行", "部署", "start", "run", "serve", "install"),
    "auth": ("登录", "鉴权", "认证", "权限", "login", "signin", "auth", "token", "session"),
    "database": ("哪张表", "数据库", "数据表", "持久化", "table", "database", "sql", "model"),
    "impact": ("影响", "修改", "调用者", "依赖", "impact", "change", "caller", "reference"),
    "api": ("接口", "路由", "端点", "api", "route", "endpoint", "controller"),
    "config": ("配置", "环境变量", "密钥", "端口", "config", "environment", "env", "setting", "port"),
    "test": ("测试", "用例", "覆盖率", "test", "spec", "coverage"),
    "error": ("报错", "异常", "错误", "失败", "error", "exception", "failed", "failure"),
}

GREETING_PATTERN = re.compile(
    r"^(?:hello(?:\s*devatlas)?|hi|hey|你好(?:\s*devatlas)?|您好|嗨)[!！,.，。\s]*$",
    re.IGNORECASE,
)
HELP_PATTERN = re.compile(
    r"^(?:/help|help|帮助|你能做什么|可以问什么|how\s+(?:can|do)\s+you\s+help)[?？!！\s]*$",
    re.IGNORECASE,
)
PROJECT_META_PATTERNS = (
    re.compile(r"(?:当前|本)(?:项目|仓库).*(?:名称|名字|叫什么|是什么)"),
    re.compile(r"(?:项目|仓库).*(?:名称|名字|叫什么)"),
    re.compile(
        r"(?:what|which).*(?:name).*(?:current\s+)?(?:project|repository)|"
        r"(?:current\s+)?(?:project|repository)\s+name",
        re.IGNORECASE,
    ),
)
LOCATION_PATTERN = re.compile(
    r"(?:在哪里|在哪个文件|位置|定位|where\s+(?:is|are|does)|which\s+file)",
    re.IGNORECASE,
)
REFERENCE_PATTERN = re.compile(r"\[(\d+)\]")
CONTEXT_TOKEN_PATTERN = re.compile(
    r"`([^`]{2,160})`|([\w./\\-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?)"
)
FOLLOW_UP_TERMS = (
    "它", "这个", "该函数", "该类", "该接口", "上述", "继续", "然后", "呢", "调用者",
    "相关测试", "影响范围", "that", "it", "this one", "continue", "what about",
)

STRONG_INTENT_TERMS = {
    "impact": ("会影响", "影响什么", "修改", "调用者", "impact", "caller"),
    "database": ("哪张表", "数据表", "表名", "database table", "which table", "sql"),
    "startup": ("如何启动", "怎么启动", "怎样运行", "how to start", "how to run"),
    "auth": ("登录功能", "鉴权流程", "认证流程", "login flow", "authentication"),
    "api": ("接口在哪里", "路由在哪里", "which endpoint", "api route"),
    "config": ("如何配置", "环境变量", "配置文件", "configuration file"),
    "test": ("相关测试", "测试用例", "test case", "test coverage"),
    "error": ("为什么报错", "异常在哪里", "错误处理", "why does it fail"),
}

EXPANSIONS = {
    "startup": "main startup start run serve dev scripts npm pnpm yarn uvicorn docker compose __main__",
    "auth": "login signin sign_in authentication authorize auth token session jwt password user route controller",
    "database": "__tablename__ table database sqlalchemy prisma repository model select insert update delete query",
    "impact": "function method class import dependency reference usage caller test spec",
    "location": "definition declaration function method class route controller service",
    "api": "api route router endpoint controller handler request response restful",
    "config": "config configuration settings environment env port secret yaml toml json",
    "test": "test tests spec fixture mock assertion coverage integration e2e",
    "error": "error exception raise catch except failure failed retry log handling",
}

IMPORTANT_FILES = {
    "readme.md": 0,
    "readme": 0,
    "package.json": 1,
    "pyproject.toml": 2,
    "docker-compose.yml": 3,
    "docker-compose.yaml": 3,
    "compose.yml": 3,
    "compose.yaml": 3,
    "makefile": 4,
    "requirements.txt": 5,
    "vite.config.ts": 6,
    "vite.config.js": 6,
}

INTENT_PATH_HINTS = {
    "startup": ("readme", "package.json", "pyproject", "compose", "docker", "main", "app"),
    "auth": ("auth", "login", "security", "session", "user", "account", "middleware"),
    "database": ("model", "schema", "database", "repository", "dao", "migration", "prisma", "sql"),
    "impact": ("test", "spec", "import", "service", "controller", "route"),
    "location": ("service", "controller", "route", "api", "src", "app"),
    "api": ("api", "route", "router", "controller", "endpoint", "handler", "view"),
    "config": ("config", "settings", "env", "compose", "yaml", "toml", "json"),
    "test": ("test", "tests", "spec", "e2e", "fixture", "mock"),
    "error": ("error", "exception", "handler", "middleware", "log", "retry"),
    "general": (),
}


def answer_repository_question(
    database: Session,
    settings: Settings,
    project: Project,
    question: str,
    provider_id: str,
    history: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    started = time.perf_counter()
    if provider_id == "local":
        raise ReportProviderError(
            "智能问答必须选择已配置的生成模型；本地规则引擎不提供问答。"
        )
    normalized_question = question.strip()
    contextual_question = _contextual_question(normalized_question, history or [])
    intents = _detect_intents(contextual_question)
    intent = intents[0]
    if intent in {"greeting", "help", "project_meta"}:
        return {
            "question": normalized_question,
            "answer": _project_context_answer(project, intent),
            "provider": provider_id,
            "engine_name": "DevAtlas Project Context",
            "citations": [],
            "evidence_count": 0,
            "reference_count": 0,
            "confidence": "high",
            "grounding_status": "project_context",
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        }
    identifiers = _meaningful_identifiers(contextual_question)
    search_query = _build_search_query(contextual_question, intents, identifiers)

    search_response = search_project(
        database,
        project,
        search_query,
        limit=18,
        index_root=settings.search_index_root,
    )
    candidates = _citations_from_search(search_response["results"])
    for detected_intent in intents:
        candidates.extend(
            _direct_file_citations(database, project, detected_intent, contextual_question)
        )
    candidates.extend(_symbol_citations(database, project, identifiers))
    if "impact" in intents:
        candidates.extend(_dependency_citations(database, project, candidates))
    if "database" in intents:
        candidates.extend(_database_dependency_citations(database, project, candidates))
    if settings.semantic_search_enabled:
        candidates.extend(
            semantic_search_project(
                database,
                project,
                contextual_question,
                settings.search_index_root,
            )
        )
        candidates = semantic_rerank_candidates(
            contextual_question,
            candidates,
            settings.search_index_root,
        )

    ranked_citations = _select_relevant_citations(
        _rank_citations(candidates, intents, identifiers),
        intents,
        identifiers,
    )[:MAX_CITATIONS]
    validated_citations = _validate_citations(database, project, ranked_citations)
    citations = [_public_citation(item) for item in validated_citations]

    if not citations:
        return {
            "question": normalized_question,
            "answer": (
                "[EVIDENCE_INSUFFICIENT] 当前仓库索引中没有找到足以支持回答的源码证据。\n"
                "请补充文件名、类名、函数名、接口路径或错误关键词后重试；"
                "DevAtlas 不会让生成模型在缺少证据时猜测。"
            ),
            "provider": provider_id,
            "engine_name": "DevAtlas Evidence Guard",
            "citations": [],
            "evidence_count": 0,
            "reference_count": 0,
            "confidence": "low",
            "grounding_status": "insufficient",
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        }

    evidence = _format_model_evidence(citations)
    answer = answer_with_report_provider(
        settings,
        provider_id,
        question=(
            f"问题意图：{' + '.join(intents)}\n"
            "请先给出结论，再给出执行流程或影响范围，并区分源码确认事实与静态推断。\n"
            f"用户问题：{normalized_question}"
        ),
        evidence=evidence,
        history=(history or [])[-6:],
    )
    reference_count = len(_valid_model_references(answer, len(citations)))
    confidence = _evidence_confidence(validated_citations, intents)
    grounding_status = "grounded" if reference_count else "reference_failed"
    if grounding_status == "reference_failed":
        confidence = "low"
    answer = _normalize_model_references(answer, citations)
    engine_name = provider_id

    return {
        "question": normalized_question,
        "answer": answer,
        "provider": provider_id,
        "engine_name": engine_name,
        "citations": citations,
        "evidence_count": len(citations),
        "reference_count": reference_count,
        "confidence": confidence,
        "grounding_status": grounding_status,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }


def _contextual_question(question: str, history: list[dict[str, str]]) -> str:
    identifiers = _meaningful_identifiers(question)
    lowered = question.lower()
    refers_to_previous = any(term in lowered for term in FOLLOW_UP_TERMS)
    if identifiers and not refers_to_previous:
        return question
    previous_users = [
        str(item.get("content", "")).strip()
        for item in history
        if item.get("role") == "user" and str(item.get("content", "")).strip()
    ]
    if not previous_users:
        return question
    previous_assistants = [
        str(item.get("content", "")).strip()
        for item in history
        if item.get("role") == "assistant" and str(item.get("content", "")).strip()
    ]
    hints = _history_context_hints(previous_assistants[-1] if previous_assistants else "")
    context = [f"上一问题：{previous_users[-1]}"]
    if hints:
        context.append("上一回答涉及：" + " ".join(hints))
    context.append(f"当前追问：{question}")
    return "\n".join(context)


def _history_context_hints(answer: str) -> list[str]:
    hints: list[str] = []
    for match in CONTEXT_TOKEN_PATTERN.finditer(answer[:6_000]):
        value = (match.group(1) or match.group(2) or "").strip()
        if value and value not in hints:
            hints.append(value)
        if len(hints) >= 8:
            break
    return hints


def _detect_intent(question: str) -> str:
    return _detect_intents(question)[0]


def _detect_intents(question: str) -> list[str]:
    normalized = question.strip()
    lowered = normalized.lower()
    if GREETING_PATTERN.fullmatch(normalized):
        return ["greeting"]
    if HELP_PATTERN.fullmatch(normalized):
        return ["help"]
    if any(pattern.search(normalized) for pattern in PROJECT_META_PATTERNS):
        return ["project_meta"]
    scores: dict[str, int] = {intent: 0 for intent in INTENT_TERMS}
    for intent, terms in STRONG_INTENT_TERMS.items():
        scores[intent] += sum(3 for term in terms if term in lowered)
    if LOCATION_PATTERN.search(normalized):
        scores["location"] = scores.get("location", 0) + 2
    for intent, terms in INTENT_TERMS.items():
        scores[intent] += sum(1 for term in terms if term in lowered)
    detected = [intent for intent, score in sorted(scores.items(), key=lambda item: -item[1]) if score]
    return detected[:3] or ["general"]


def _meaningful_identifiers(question: str) -> list[str]:
    identifiers: list[str] = []
    lowered_question = question.lower()
    for term, aliases in IDENTIFIER_ALIASES.items():
        if term in lowered_question:
            identifiers.extend(alias for alias in aliases if alias not in identifiers)
    for match in IDENTIFIER_PATTERN.findall(question):
        normalized = match.strip("./:-").lower()
        if normalized in GENERIC_IDENTIFIERS or len(normalized) < 3:
            continue
        if normalized not in identifiers:
            identifiers.append(normalized)
    return identifiers[:8]


def _build_search_query(question: str, intents: list[str], identifiers: list[str]) -> str:
    expansions = [EXPANSIONS.get(intent, "") for intent in intents]
    return " ".join([question, *identifiers, *expansions]).strip()


def _citations_from_search(results: object) -> list[dict[str, object]]:
    citations: list[dict[str, object]] = []
    if not isinstance(results, list):
        return citations
    for item in results:
        if not isinstance(item, dict):
            continue
        citations.append(
            {
                "file_id": int(item["file_id"]),
                "file_path": str(item["file_path"]),
                "start_line": int(item["snippet_start_line"]),
                "end_line": int(item["snippet_end_line"]),
                "symbol_name": item.get("symbol_name"),
                "snippet": str(item["snippet"])[:MAX_EVIDENCE_CHARS],
                "source": "code_search",
                "_score": min(float(item.get("score", 0.0)), 25.0),
            }
        )
    return citations


def _database_dependency_citations(
    database: Session, project: Project, candidates: list[dict[str, object]]
) -> list[dict[str, object]]:
    frontier = {
        int(item["file_id"])
        for item in candidates
        if item.get("source") in {"symbol_exact", "symbol_match", "symbol_fuzzy"}
    }
    if not frontier:
        return []
    repository_root = resolve_project_storage_path(project.storage_path)
    visited = set(frontier)
    citations: list[dict[str, object]] = []
    for depth in range(1, 3):
        relations = list(
            database.scalars(
                select(ImportRelation)
                .where(
                    ImportRelation.project_id == project.id,
                    ImportRelation.file_id.in_(frontier),
                    ImportRelation.resolved_file_id.is_not(None),
                )
                .limit(60)
            )
        )
        next_frontier = {
            int(relation.resolved_file_id)
            for relation in relations
            if relation.resolved_file_id is not None
            and int(relation.resolved_file_id) not in visited
        }
        if not next_frontier:
            break
        visited.update(next_frontier)
        for file_id in next_frontier:
            project_file = database.get(ProjectFile, file_id)
            if project_file is None:
                continue
            lines = _read_project_lines(repository_root, project_file.relative_path)
            match_index = next(
                (index for index, line in enumerate(lines) if _extract_database_entities(line)),
                None,
            )
            if match_index is None:
                continue
            start_index = max(0, match_index - 2)
            end_index = min(len(lines), match_index + 4)
            citations.append(
                _citation(
                    project_file,
                    start_index + 1,
                    end_index,
                    lines[start_index:end_index],
                    None,
                    "dependency_target",
                    28.0 - depth * 4,
                )
            )
        frontier = next_frontier
    return citations


def _direct_file_citations(
    database: Session, project: Project, intent: str, question: str
) -> list[dict[str, object]]:
    if intent not in {"startup", "general"}:
        return []
    files = list(
        database.scalars(
            select(ProjectFile)
            .where(ProjectFile.project_id == project.id)
            .order_by(ProjectFile.relative_path)
        )
    )
    candidates = sorted(
        (
            item
            for item in files
            if Path(item.relative_path).name.lower() in IMPORTANT_FILES
            and item.size_bytes <= MAX_DIRECT_FILE_BYTES
        ),
        key=lambda item: (
            IMPORTANT_FILES[Path(item.relative_path).name.lower()],
            item.relative_path.count("/"),
            item.relative_path,
        ),
    )[:8]
    repository_root = resolve_project_storage_path(project.storage_path)
    question_terms = [term.lower() for term in _meaningful_identifiers(question)]
    citations: list[dict[str, object]] = []
    for project_file in candidates:
        lines = _read_project_lines(repository_root, project_file.relative_path)
        if not lines:
            continue
        match_index = _direct_match_index(lines, project_file.relative_path, intent, question_terms)
        if match_index is None:
            continue
        start_index = max(0, match_index - 2)
        end_index = min(len(lines), match_index + (9 if Path(project_file.relative_path).name.lower() == "package.json" else 5))
        citations.append(
            _citation(
                project_file,
                start_index + 1,
                end_index,
                lines[start_index:end_index],
                None,
                "project_file",
                22.0,
            )
        )
    return citations


def _direct_match_index(
    lines: list[str], relative_path: str, intent: str, question_terms: list[str]
) -> int | None:
    if intent == "startup":
        filename = Path(relative_path).name.lower()
        anchors = {
            "package.json": ("\"scripts\"",),
            "pyproject.toml": ("[project.scripts]", "[tool.poetry.scripts]"),
            "docker-compose.yml": ("services:", "command:"),
            "docker-compose.yaml": ("services:", "command:"),
            "compose.yml": ("services:", "command:"),
            "compose.yaml": ("services:", "command:"),
            "makefile": ("run:", "start:", "dev:"),
        }.get(filename, ())
        scored_lines: list[tuple[int, int]] = []
        for index, line in enumerate(lines):
            score = 0
            commands = _startup_commands_from_line(line)
            if commands:
                score = 120 if any(
                    re.search(r"\b(up|start|dev|serve|launch)\b|uvicorn", command, re.IGNORECASE)
                    for command in commands
                ) else 90
            if STARTUP_HEADING_PATTERN.search(line):
                score = max(score, 105)
            if any(anchor in line.lower() for anchor in anchors):
                score = max(score, 110)
            if score:
                scored_lines.append((score, index))
        if not scored_lines:
            return None
        return max(scored_lines, key=lambda item: (item[0], -item[1]))[1]
    if not question_terms:
        return 0 if Path(relative_path).name.lower().startswith("readme") else None
    return next(
        (index for index, line in enumerate(lines) if any(term in line.lower() for term in question_terms)),
        None,
    )


def _symbol_citations(
    database: Session, project: Project, identifiers: list[str]
) -> list[dict[str, object]]:
    if not identifiers:
        return []
    rows: list[tuple[CodeSymbol, ProjectFile]] = []
    seen_symbol_ids: set[int] = set()
    fuzzy_scores: dict[int, float] = {}
    for identifier in identifiers[:5]:
        exact_rows = database.execute(
            select(CodeSymbol, ProjectFile)
            .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
            .where(
                CodeSymbol.project_id == project.id,
                or_(
                    CodeSymbol.name.ilike(identifier),
                    CodeSymbol.qualified_name.ilike(identifier),
                    CodeSymbol.qualified_name.ilike(f"%.{identifier}"),
                ),
            )
            .order_by(ProjectFile.relative_path, CodeSymbol.start_line)
            .limit(6)
        ).all()
        for row in exact_rows:
            if row[0].id not in seen_symbol_ids:
                rows.append(row)
                seen_symbol_ids.add(row[0].id)
    filters = []
    for identifier in identifiers[:5]:
        pattern = f"%{identifier}%"
        filters.extend((CodeSymbol.name.ilike(pattern), CodeSymbol.qualified_name.ilike(pattern)))
    partial_rows = database.execute(
        select(CodeSymbol, ProjectFile)
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(CodeSymbol.project_id == project.id, or_(*filters))
        .order_by(ProjectFile.relative_path, CodeSymbol.start_line)
        .limit(20)
    ).all()
    for row in partial_rows:
        if row[0].id not in seen_symbol_ids:
            rows.append(row)
            seen_symbol_ids.add(row[0].id)
    for identifier in (item for item in identifiers[:5] if len(item) >= 4):
        anchors = {identifier[:3], identifier[-3:]}
        fuzzy_filters = []
        for anchor in anchors:
            pattern = f"%{anchor}%"
            fuzzy_filters.extend(
                (CodeSymbol.name.ilike(pattern), CodeSymbol.qualified_name.ilike(pattern))
            )
        fuzzy_rows = database.execute(
            select(CodeSymbol, ProjectFile)
            .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
            .where(CodeSymbol.project_id == project.id, or_(*fuzzy_filters))
            .order_by(ProjectFile.relative_path, CodeSymbol.start_line)
            .limit(160)
        ).all()
        for symbol, project_file in fuzzy_rows:
            if symbol.id in seen_symbol_ids:
                continue
            symbol_names = {
                symbol.name.lower(),
                symbol.qualified_name.lower(),
                symbol.qualified_name.lower().split(".")[-1],
            }
            similarity = max(
                SequenceMatcher(None, identifier, candidate).ratio()
                for candidate in symbol_names
            )
            if similarity < 0.72:
                continue
            rows.append((symbol, project_file))
            seen_symbol_ids.add(symbol.id)
            fuzzy_scores[symbol.id] = similarity
    repository_root = resolve_project_storage_path(project.storage_path)
    citations: list[dict[str, object]] = []
    for symbol, project_file in rows:
        lines = _read_project_lines(repository_root, project_file.relative_path)
        if not lines:
            continue
        start_line = max(1, symbol.start_line)
        end_line = min(len(lines), max(start_line, min(symbol.end_line, start_line + 18)))
        exact = symbol.name.lower() in identifiers or any(
            symbol.qualified_name.lower() == identifier
            or symbol.qualified_name.lower().endswith(f".{identifier}")
            for identifier in identifiers
        )
        fuzzy_similarity = fuzzy_scores.get(symbol.id)
        citations.append(
            _citation(
                project_file,
                start_line,
                end_line,
                lines[start_line - 1 : end_line],
                symbol.qualified_name,
                "symbol_exact" if exact else "symbol_fuzzy" if fuzzy_similarity else "symbol_match",
                30.0 if exact else 12.0 + (fuzzy_similarity or 0.6) * 10,
            )
        )
    return citations


def _dependency_citations(
    database: Session, project: Project, candidates: list[dict[str, object]]
) -> list[dict[str, object]]:
    target_file_ids = {
        int(item["file_id"])
        for item in candidates
        if item.get("source") in {"symbol_exact", "symbol_match", "symbol_fuzzy"}
    }
    if not target_file_ids:
        target_file_ids = {int(item["file_id"]) for item in candidates[:3]}
    if not target_file_ids:
        return []
    rows = database.execute(
        select(ImportRelation, ProjectFile)
        .join(ProjectFile, ProjectFile.id == ImportRelation.file_id)
        .where(
            ImportRelation.project_id == project.id,
            or_(
                ImportRelation.file_id.in_(target_file_ids),
                ImportRelation.resolved_file_id.in_(target_file_ids),
            ),
        )
        .order_by(ImportRelation.source_path, ImportRelation.line_number)
        .limit(24)
    ).all()
    repository_root = resolve_project_storage_path(project.storage_path)
    citations: list[dict[str, object]] = []
    for relation, project_file in rows:
        lines = _read_project_lines(repository_root, project_file.relative_path)
        if not lines:
            continue
        start_line = max(1, relation.line_number - 1)
        end_line = min(len(lines), relation.line_number + 2)
        citations.append(
            _citation(
                project_file,
                start_line,
                end_line,
                lines[start_line - 1 : end_line],
                relation.target_module,
                "dependency_relation",
                17.0 if relation.resolved_file_id in target_file_ids else 11.0,
            )
        )
    return citations


def _rank_citations(
    citations: list[dict[str, object]], intents: list[str], identifiers: list[str]
) -> list[dict[str, object]]:
    ranked: list[tuple[float, dict[str, object]]] = []
    hints = tuple(
        dict.fromkeys(
            hint for intent in intents for hint in INTENT_PATH_HINTS.get(intent, ())
        )
    )
    for citation in citations:
        path = str(citation["file_path"]).lower()
        snippet = str(citation["snippet"]).lower()
        symbol = str(citation.get("symbol_name") or "").lower()
        score = float(citation.get("_score", 0.0))
        scope = classify_code_scope(path)
        if scope == "generated":
            score -= 60
        elif scope == "test":
            score += 10 if any(intent in {"test", "impact"} for intent in intents) else -28
        else:
            score += 6
        score += {
            "symbol_exact": 16,
            "symbol_match": 10,
            "symbol_fuzzy": 5,
            "project_file": 8,
            "dependency_target": 7,
            "dependency_relation": 5,
            "code_search": 0,
            "semantic_search": 8,
        }.get(str(citation.get("source")), 0)
        matched_identifiers = 0
        for identifier_index, identifier in enumerate(identifiers):
            if symbol == identifier or symbol.endswith(f".{identifier}"):
                score += max(12, 24 - identifier_index * 4)
                matched_identifiers += 1
            elif identifier in symbol:
                score += max(7, 13 - identifier_index * 2)
                matched_identifiers += 1
            if identifier in path:
                score += 9
                matched_identifiers += 1
            if identifier in snippet:
                score += 6
                matched_identifiers += 1
        if identifiers and not matched_identifiers:
            score -= 12
        score += min(12, sum(4 for hint in hints if hint in path))
        if "startup" in intents and Path(path).name in IMPORTANT_FILES:
            score += 16 - min(IMPORTANT_FILES[Path(path).name], 10)
            score += max(0, 12 - path.count("/") * 5)
        if "impact" in intents and _is_test_path(path):
            score += 9
        elif "test" not in intents and _is_test_path(path):
            score -= 30
        if "database" in intents and _extract_database_entities(snippet):
            score += 14
        citation["_score"] = score
        ranked.append((score, citation))

    ranked.sort(
        key=lambda item: (
            -item[0],
            str(item[1]["file_path"]),
            int(item[1]["start_line"]),
        )
    )
    result: list[dict[str, object]] = []
    seen: set[tuple[int, int, int]] = set()
    per_file: Counter[int] = Counter()
    selected_token_sets: list[set[str]] = []
    for _, citation in ranked:
        key = (
            int(citation["file_id"]),
            int(citation["start_line"]),
            int(citation["end_line"]),
        )
        file_id = int(citation["file_id"])
        token_set = set(tokenize(str(citation["snippet"])))
        too_similar = any(
            len(token_set & selected) / max(1, len(token_set | selected)) >= 0.82
            for selected in selected_token_sets
        )
        if key in seen or per_file[file_id] >= 2 or too_similar:
            continue
        seen.add(key)
        per_file[file_id] += 1
        selected_token_sets.append(token_set)
        result.append(citation)
    return result


def _select_relevant_citations(
    citations: list[dict[str, object]],
    intents: list[str],
    identifiers: list[str],
) -> list[dict[str, object]]:
    """Keep evidence with a traceable lexical, structural, or strong semantic match."""
    selected: list[dict[str, object]] = []
    intent_set = set(intents)
    for citation in citations:
        path = str(citation["file_path"]).lower()
        snippet = str(citation["snippet"]).lower()
        symbol = str(citation.get("symbol_name") or "").lower()
        source = str(citation.get("source") or "")
        semantic_score = float(citation.get("_semantic_score", 0.0))
        searchable = f"{path}\n{symbol}\n{snippet}"
        identifier_match = any(identifier in searchable for identifier in identifiers)
        structural_match = (
            source in {"symbol_exact", "symbol_match", "symbol_fuzzy"}
            or (source == "project_file" and "startup" in intent_set)
            or (source == "dependency_relation" and "impact" in intent_set)
            or (source == "dependency_target" and "database" in intent_set)
            or ("test" in intent_set and _is_test_path(path))
        )
        intent_match = any(
            hint in path or hint in snippet
            for intent in intents
            for hint in INTENT_PATH_HINTS.get(intent, ())
        )
        lexical_score = float(citation.get("_score", 0.0))
        strong_semantic_match = semantic_score >= MIN_SEMANTIC_RELEVANCE

        if identifiers:
            relevant = identifier_match or structural_match or strong_semantic_match
        else:
            relevant = (
                structural_match
                or strong_semantic_match
                or (intent_match and lexical_score >= 16.0)
                or (source == "code_search" and lexical_score >= 14.0)
            )
        if relevant:
            selected.append(citation)
    return selected


def _local_answer(
    question: str,
    intents: list[str],
    identifiers: list[str],
    citations: list[dict[str, object]],
) -> str:
    if not citations:
        return (
            "结论（证据不足）：当前索引没有找到能够回答该问题的源码依据。\n"
            "请补充接口路径、文件名、类名或函数名；系统不会在缺少证据时猜测。"
        )
    answer_intents = [intent for intent in intents if intent != "general"]
    if len(answer_intents) > 1:
        sections: list[str] = [
            f"结论：该问题包含 {len(answer_intents[:2])} 个分析目标，已分别检索并合并证据。"
        ]
        labels = {
            "startup": "启动与运行",
            "auth": "登录与认证",
            "database": "数据库访问",
            "impact": "修改影响",
            "location": "源码位置",
            "api": "接口与路由",
            "config": "配置与环境",
            "test": "测试与验证",
            "error": "异常与错误处理",
        }
        for detected_intent in answer_intents[:2]:
            sections.append(f"### {labels[detected_intent]}")
            sections.append(
                _answer_for_intent(question, detected_intent, identifiers, citations)
            )
        return "\n".join(sections)
    intent = answer_intents[0] if answer_intents else "general"
    return _answer_for_intent(question, intent, identifiers, citations)


def _answer_for_intent(
    question: str,
    intent: str,
    identifiers: list[str],
    citations: list[dict[str, object]],
) -> str:
    if intent == "startup":
        return _startup_answer(citations)
    if intent == "auth":
        return _auth_answer(citations)
    if intent == "database":
        return _database_answer(citations, identifiers)
    if intent == "impact":
        return _impact_answer(question, identifiers, citations)
    if intent == "location":
        return _location_answer(question, identifiers, citations)
    if intent in {"api", "config", "test", "error"}:
        return _focused_evidence_answer(intent, citations)
    return _general_answer(citations)


def _focused_evidence_answer(intent: str, citations: list[dict[str, object]]) -> str:
    descriptions = {
        "api": "已定位最相关的接口、路由或请求处理代码。",
        "config": "已定位最相关的配置、环境变量或运行参数。",
        "test": "已定位最相关的测试、夹具或验证代码。",
        "error": "已定位最相关的异常来源与错误处理代码。",
    }
    hints = INTENT_PATH_HINTS[intent]
    focused = [
        item
        for item in citations
        if any(hint in str(item["file_path"]).lower() for hint in hints)
    ]
    selected = focused or citations
    confidence = "高" if focused else "中"
    lines = [f"结论（{confidence}置信）：{descriptions[intent]}"]
    if selected is not citations:
        lines.append("相关路径集中在：" + _compact_references(selected, citations))
    lines.extend(_evidence_lines(citations, limit=6))
    return "\n".join(lines)


def _project_context_answer(project: Project, intent: str) -> str:
    if intent == "greeting":
        return (
            f"你好，我是 DevAtlas 智能问答助手。当前项目是 `{project.name}`。\n"
            "你可以询问启动方式、功能位置、数据库访问、修改影响，或输入 `/help` 查看示例。"
        )
    if intent == "help":
        return (
            f"当前项目：`{project.name}`。可以直接询问：\n"
            "- 这个项目如何启动？\n"
            "- 登录功能在哪里？\n"
            "- login 接口最后访问哪张表？\n"
            "- 修改 login 会影响什么？\n"
            "- 上传失败的异常在哪里处理？\n"
            "- 哪些测试覆盖了登录功能？\n"
            "回答源码问题时会附带文件路径和行号。"
        )
    language = project.primary_language or "尚未识别"
    return (
        f"当前项目名称是 `{project.name}`。\n"
        f"导入来源：`{project.source_filename}`\n"
        f"主要语言：`{language}`\n"
        "以上信息来自 DevAtlas 当前项目记录，不是源码检索推断。"
    )


def _startup_answer(citations: list[dict[str, object]]) -> str:
    commands = _extract_startup_commands(citations)
    confidence = "高" if commands and any(item["source"] == "project_file" for item in citations) else "中"
    lines = [f"结论（{confidence}置信）：已定位项目启动说明或启动配置。"]
    if commands:
        lines.append("建议按以下命令或脚本启动：")
        lines.extend(f"- `{command}` {reference}" for command, reference in commands[:4])
    else:
        lines.append("没有提取到可直接执行的完整命令，请优先检查以下配置，不建议凭文件名猜测启动方式。")
    lines.extend(_evidence_lines(citations, limit=5))
    return "\n".join(lines)


def _auth_answer(citations: list[dict[str, object]]) -> str:
    groups: dict[str, list[tuple[int, dict[str, object]]]] = {
        "入口/路由": [], "核心认证": [], "数据与状态": [], "相关测试": [], "其他证据": []
    }
    for index, citation in enumerate(citations, 1):
        path = str(citation["file_path"]).lower()
        snippet = str(citation["snippet"]).lower()
        if _is_test_path(path):
            label = "相关测试"
        elif any(term in path for term in ("route", "controller", "api", "endpoint")):
            label = "入口/路由"
        elif any(term in path or term in snippet for term in ("auth", "login", "token", "jwt", "password")):
            label = "核心认证"
        elif any(term in path for term in ("model", "user", "session", "repository")):
            label = "数据与状态"
        else:
            label = "其他证据"
        groups[label].append((index, citation))
    populated = sum(bool(items) for items in groups.values())
    confidence = "高" if populated >= 2 else "中"
    lines = [f"结论（{confidence}置信）：登录/鉴权实现集中在以下层次。"]
    for label, items in groups.items():
        if not items:
            continue
        previews = "；".join(
            f"[{index}] `{item['file_path']}:{item['start_line']}-{item['end_line']}`"
            for index, item in items[:3]
        )
        lines.append(f"- {label}：{previews}")
    lines.append("说明：这是静态源码定位；运行时中间件或外部身份服务需要结合部署配置继续确认。")
    return "\n".join(lines)


def _database_answer(
    citations: list[dict[str, object]], identifiers: list[str]
) -> str:
    entities: list[tuple[str, int]] = []
    seen: set[str] = set()
    for index, citation in enumerate(citations, 1):
        searchable = " ".join(
            (
                str(citation["file_path"]),
                str(citation.get("symbol_name") or ""),
                str(citation["snippet"]),
            )
        ).lower()
        if (
            identifiers
            and citation.get("source") != "dependency_target"
            and not any(identifier in searchable for identifier in identifiers)
        ):
            continue
        for entity in _extract_database_entities(str(citation["snippet"])):
            normalized = entity.lower()
            if normalized in seen:
                continue
            seen.add(normalized)
            entities.append((entity, index))
    if entities:
        lines = ["结论（高置信）：源码中能够确认以下数据表或 ORM 实体："]
        lines.extend(f"- `{entity}` [{index}]" for entity, index in entities[:8])
    else:
        lines = [
            "结论（低置信）：已找到数据库相关代码，但证据中没有出现明确表名或 ORM 表映射，不能确认最终访问哪张表。"
        ]
    lines.extend(_evidence_lines(citations, limit=6))
    lines.append("说明：动态 SQL、存储过程或运行时路由可能无法通过静态检索完整还原。")
    return "\n".join(lines)


def _impact_answer(
    question: str, identifiers: list[str], citations: list[dict[str, object]]
) -> str:
    target = identifiers[0] if identifiers else question[:40]
    direct = [
        item
        for item in citations
        if item["source"] in {"symbol_exact", "symbol_match", "symbol_fuzzy", "code_search"}
    ]
    dependencies = [item for item in citations if item["source"] == "dependency_relation"]
    tests = [item for item in citations if _is_test_path(str(item["file_path"]))]
    confidence = "高" if dependencies and direct else "中" if direct else "低"
    lines = [f"结论（{confidence}置信）：对 `{target}` 的静态修改影响如下。"]
    if direct:
        lines.append("- 直接定义/引用：" + _compact_references(direct, citations))
    if dependencies:
        lines.append("- 模块依赖传播：" + _compact_references(dependencies, citations))
    if tests:
        lines.append("- 相关测试：" + _compact_references(tests, citations))
    if not tests:
        lines.append("- 相关测试：当前证据中未定位到明确测试，修改后需要补充定向验证。")
    lines.append("风险边界：这里只进行按需、有限范围的静态追踪，不代表运行时完整调用链。")
    return "\n".join(lines)


def _location_answer(
    question: str, identifiers: list[str], citations: list[dict[str, object]]
) -> str:
    exact = [item for item in citations if item["source"] == "symbol_exact"]
    related = [item for item in citations if item["source"] != "symbol_exact"]
    target = identifiers[0] if identifiers else question[:40]
    confidence = "高" if exact else "中" if citations else "低"
    lines = [f"结论（{confidence}置信）：`{target}` 的源码位置如下。"]
    if exact:
        lines.append("- 精确定义：" + _compact_references(exact, citations))
    if related:
        lines.append("- 相关实现或引用：" + _compact_references(related, citations))
    if not citations:
        lines.append("当前索引没有找到匹配位置，请补充准确的文件名、类名或函数名。")
    return "\n".join(lines)


def _general_answer(citations: list[dict[str, object]]) -> str:
    primary = citations[0]
    lines = [
        "结论（中置信）：已通过源码内容、符号和路径联合检索定位相关实现。",
        f"最相关位置是 `{primary['file_path']}:{primary['start_line']}-{primary['end_line']}`"
        f"；核心片段表明：{_evidence_preview(str(primary['snippet']))} [1]",
    ]
    lines.extend(_evidence_lines(citations, limit=6))
    lines.append("可以继续指定其中的文件、类或函数追问，以缩小分析范围。")
    return "\n".join(lines)


def _evidence_lines(citations: list[dict[str, object]], limit: int) -> list[str]:
    lines = ["依据："]
    for index, citation in enumerate(citations[:limit], 1):
        symbol = f" · `{citation['symbol_name']}`" if citation.get("symbol_name") else ""
        preview = _evidence_preview(str(citation["snippet"]))
        lines.append(
            f"[{index}] `{citation['file_path']}:{citation['start_line']}-{citation['end_line']}`"
            f"{symbol} — {preview}"
        )
    return lines


def _compact_references(
    selected: list[dict[str, object]], all_citations: list[dict[str, object]]
) -> str:
    positions = {id(item): index for index, item in enumerate(all_citations, 1)}
    return "；".join(
        f"[{positions[id(item)]}] `{item['file_path']}:{item['start_line']}-{item['end_line']}`"
        for item in selected[:4]
    )


def _extract_startup_commands(
    citations: list[dict[str, object]],
) -> list[tuple[str, str]]:
    commands: list[tuple[int, str, str]] = []
    seen: set[str] = set()
    script_pattern = re.compile(r'"(dev|start|serve|preview)"\s*:\s*"([^"]+)"', re.IGNORECASE)
    for index, citation in enumerate(citations, 1):
        snippet = str(citation["snippet"])
        found = [
            command
            for line in snippet.splitlines()
            for command in _startup_commands_from_line(line)
        ]
        if Path(str(citation["file_path"])).name.lower() == "package.json":
            found.extend(
                "npm start" if name.lower() == "start" else f"npm run {name}"
                for name, _ in script_pattern.findall(snippet)
            )
        for command in found:
            normalized = re.sub(r"\s+", " ", str(command)).strip().rstrip(".,;")
            if normalized.lower() in seen or len(normalized) > 180:
                continue
            seen.add(normalized.lower())
            path = str(citation["file_path"]).lower()
            score = max(0, 20 - index)
            if re.search(r"\b(up|start|dev|serve)\b|uvicorn|launch_backend", normalized, re.IGNORECASE):
                score += 80
            elif re.search(r"\b(build|install|sync|clone)\b", normalized, re.IGNORECASE):
                score += 40
            if re.search(r"\b(down|stop|pkill)\b", normalized, re.IGNORECASE):
                score -= 100
            if _is_test_path(path) or re.search(r"\btest", normalized, re.IGNORECASE):
                score -= 50
            if "/" not in path:
                score += 20
            commands.append((score, normalized, f"[{index}]"))
    commands.sort(key=lambda item: (-item[0], item[1].lower()))
    return [(command, reference) for _, command, reference in commands]


def _startup_commands_from_line(line: str) -> list[str]:
    inline_candidates = re.findall(r"`([^`\n]+)`", line)
    normalized_line = re.sub(
        r"^\s*(?:>\s*)?(?:[-+*]\s*)?(?:\d+[.)]\s*)?", "", line
    ).strip()
    normalized_line = normalized_line.strip("` ")
    candidates = [*inline_candidates, normalized_line]
    commands: list[str] = []
    for candidate in candidates:
        normalized = re.sub(r"\s+", " ", candidate).strip().rstrip(".,;")
        if STARTUP_COMMAND_PATTERN.fullmatch(normalized) and normalized not in commands:
            commands.append(normalized)
    return commands


def _extract_database_entities(snippet: str) -> list[str]:
    patterns = (
        (r"__tablename__\s*=\s*['\"]([A-Za-z0-9_.-]+)['\"]", re.IGNORECASE),
        (r"\bTable\(\s*['\"]([A-Za-z0-9_.-]+)['\"]", re.IGNORECASE),
        (
            r"\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE)\s+[`\"\[]?([A-Za-z_][A-Za-z0-9_.-]*)",
            0,
        ),
        (r"\bprisma\.([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE),
        (
            r"\bclass\s+([A-Z][A-Za-z0-9_]*)\s*\([^)]*\b(?:DataBaseModel|BaseModel|Model)\b[^)]*\)\s*:",
            0,
        ),
    )
    entities: list[str] = []
    for pattern, flags in patterns:
        for match in re.findall(pattern, snippet, flags=flags):
            entity = str(match).strip("`\"[]")
            if (
                entity
                and entity.lower() not in DATABASE_ENTITY_STOPWORDS
                and entity.lower() not in {item.lower() for item in entities}
            ):
                entities.append(entity)
    return entities


def _evidence_preview(snippet: str) -> str:
    lines = [re.sub(r"\s+", " ", line.strip()) for line in snippet.splitlines() if line.strip()]
    selected = lines[0] if lines else "已找到相关源码片段"
    return selected[:157] + ("..." if len(selected) > 157 else "")


def _is_test_path(path: str) -> bool:
    lowered = path.replace("\\", "/").lower()
    name = Path(lowered).name
    return (
        "/test/" in f"/{lowered}/"
        or "/tests/" in f"/{lowered}/"
        or "__tests__" in lowered
        or name.startswith("test_")
        or ".test." in name
        or ".spec." in name
    )


def _citation(
    project_file: ProjectFile,
    start_line: int,
    end_line: int,
    lines: list[str],
    symbol_name: str | None,
    source: str,
    score: float,
) -> dict[str, object]:
    return {
        "file_id": project_file.id,
        "file_path": project_file.relative_path,
        "start_line": start_line,
        "end_line": end_line,
        "symbol_name": symbol_name,
        "snippet": "\n".join(lines)[:MAX_EVIDENCE_CHARS],
        "source": source,
        "_score": score,
    }


def _read_project_lines(repository_root: Path, relative_path: str) -> list[str]:
    source_path = _safe_source_path(repository_root, relative_path)
    if source_path is None:
        return []
    try:
        return source_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def _safe_source_path(repository_root: Path, relative_path: str) -> Path | None:
    try:
        source_path = (repository_root / relative_path).resolve()
        if not source_path.is_relative_to(repository_root) or not source_path.is_file():
            return None
        return source_path
    except OSError:
        return None


def _validate_citations(
    database: Session,
    project: Project,
    citations: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Reject stale/cross-project evidence and refresh snippets from the current file."""
    if not citations:
        return []
    file_ids = {int(item["file_id"]) for item in citations}
    project_files = {
        item.id: item
        for item in database.scalars(
            select(ProjectFile).where(
                ProjectFile.project_id == project.id,
                ProjectFile.id.in_(file_ids),
            )
        )
    }
    repository_root = resolve_project_storage_path(project.storage_path)
    line_cache: dict[int, list[str]] = {}
    validated: list[dict[str, object]] = []
    for citation in citations:
        file_id = int(citation["file_id"])
        project_file = project_files.get(file_id)
        if project_file is None or str(citation["file_path"]) != project_file.relative_path:
            continue
        lines = line_cache.setdefault(
            file_id,
            _read_project_lines(repository_root, project_file.relative_path),
        )
        start_line = int(citation["start_line"])
        end_line = int(citation["end_line"])
        if not lines or start_line < 1 or end_line < start_line or start_line > len(lines):
            continue
        end_line = min(end_line, len(lines))
        refreshed = dict(citation)
        refreshed["end_line"] = end_line
        refreshed["snippet"] = "\n".join(lines[start_line - 1 : end_line])[:MAX_EVIDENCE_CHARS]
        validated.append(refreshed)
    return validated


def _normalize_model_references(
    answer: str, citations: list[dict[str, object]]
) -> str:
    """Remove impossible model references and guarantee a clickable evidence footer."""
    maximum = len(citations)
    valid_references: set[int] = set()

    def replace_reference(match: re.Match[str]) -> str:
        reference = int(match.group(1))
        if 1 <= reference <= maximum:
            valid_references.add(reference)
            return match.group(0)
        return ""

    normalized = REFERENCE_PATTERN.sub(replace_reference, answer).strip()
    if citations and not valid_references:
        references = "；".join(
            f"[{index}] `{item['file_path']}:{item['start_line']}-{item['end_line']}`"
            for index, item in enumerate(citations[:3], 1)
        )
        return (
            "[REFERENCE_CHECK_FAILED] 模型回答未包含可验证的仓库引用，因此未展示其结论。\n"
            f"已检索到的候选证据：{references}\n"
            "可以切换模型重试，或在问题中补充文件名、类名、函数名或接口路径。"
        )
    return normalized


def _valid_model_references(answer: str, maximum: int) -> set[int]:
    return {
        reference
        for reference in (int(match) for match in REFERENCE_PATTERN.findall(answer))
        if 1 <= reference <= maximum
    }


def _evidence_confidence(
    citations: list[dict[str, object]], intents: list[str]
) -> str:
    if not citations:
        return "low"
    sources = {str(item.get("source") or "") for item in citations}
    production_files = {
        int(item["file_id"])
        for item in citations
        if classify_code_scope(str(item["file_path"])) == "production"
    }
    semantic_peak = max(
        (float(item.get("_semantic_score", 0.0)) for item in citations),
        default=0.0,
    )
    if (
        "symbol_exact" in sources
        or ("startup" in intents and "project_file" in sources)
        or (len(production_files) >= 2 and semantic_peak >= 0.55)
    ):
        return "high"
    return "medium"


def _public_citation(citation: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in citation.items() if not key.startswith("_")}


def _format_model_evidence(citations: list[dict[str, object]]) -> str:
    if not citations:
        return "没有检索到可引用的仓库证据。"
    return "\n\n".join(
        f"[{index}] {citation['file_path']}:{citation['start_line']}-{citation['end_line']}\n"
        f"{citation['snippet']}"
        for index, citation in enumerate(citations, 1)
    )
