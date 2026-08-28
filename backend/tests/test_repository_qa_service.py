import pytest

from app.services.repository_qa_service import (
    _contextual_question,
    _detect_intent,
    _detect_intents,
    _evidence_confidence,
    _extract_database_entities,
    _extract_startup_commands,
    _history_context_hints,
    _meaningful_identifiers,
    _normalize_model_references,
    _rank_citations,
    _select_relevant_citations,
    _valid_model_references,
)
from app.services.search_service import tokenize


def test_follow_up_question_reuses_the_previous_user_target() -> None:
    contextual = _contextual_question(
        "修改它会影响什么？",
        [
            {"role": "user", "content": "login_user 在哪里？"},
            {"role": "assistant", "content": "位于 auth.py"},
        ],
    )

    assert "login_user" in contextual
    assert _detect_intent(contextual) == "impact"
    assert "login_user" in _meaningful_identifiers(contextual)


def test_follow_up_question_reuses_symbols_and_paths_from_the_previous_answer() -> None:
    contextual = _contextual_question(
        "相关测试呢？",
        [
            {"role": "user", "content": "登录功能在哪里？"},
            {
                "role": "assistant",
                "content": "入口是 `login_user`，位于 `backend/auth.py:30-42` [1]。",
            },
        ],
    )

    assert "login_user" in contextual
    assert "backend/auth.py:30-42" in contextual
    assert _history_context_hints("`AuthService.login` 与 src/auth.py:10-20") == [
        "AuthService.login",
        "src/auth.py:10-20",
    ]


def test_detects_conversation_and_project_context_questions() -> None:
    assert _detect_intent("helloDevAtlas") == "greeting"
    assert _detect_intent("/help") == "help"
    assert _detect_intent("what is the name of the current project") == "project_meta"
    assert _detect_intent("payment_service 在哪个文件？") == "location"


def test_detects_multiple_repository_intents() -> None:
    assert _detect_intents("登录接口如何认证并访问哪张表？")[:2] == ["database", "auth"]
    assert _detect_intents("配置文件在哪里？") == ["config", "location"]
    assert _detect_intents("上传失败的异常在哪里处理？") == ["error", "location"]
    assert _detect_intents("有哪些测试覆盖登录功能？")[:2] == ["auth", "test"]


@pytest.mark.parametrize(
    ("question", "expected_intent"),
    [
        ("这个项目如何启动？", "startup"),
        ("登录鉴权流程在哪里？", "auth"),
        ("订单接口访问哪张表？", "database"),
        ("修改 payment_service 会影响什么？", "impact"),
        ("上传接口定义在哪里？", "api"),
        ("服务端口如何配置？", "config"),
        ("有哪些测试覆盖缓存功能？", "test"),
        ("上传失败的异常在哪里处理？", "error"),
    ],
)
def test_standard_repository_question_set(question: str, expected_intent: str) -> None:
    assert expected_intent in _detect_intents(question)


def test_chinese_tokenization_adds_bigrams_for_fuzzy_recall() -> None:
    tokens = tokenize("项目在哪里处理文件上传")

    assert "文件" in tokens
    assert "上传" in tokens
    assert "处理" in tokens
    assert _meaningful_identifiers("文件上传接口报错") == [
        "upload",
        "multipart",
        "file",
        "api",
        "route",
        "endpoint",
        "error",
        "exception",
    ]
    assert _meaningful_identifiers("订单支付后保存缓存")[:6] == [
        "payment",
        "billing",
        "checkout",
        "order",
        "purchase",
        "cache",
    ]


def test_evidence_reranking_prefers_production_and_removes_near_duplicates() -> None:
    base = {
        "file_id": 1,
        "start_line": 1,
        "end_line": 4,
        "symbol_name": "login_user",
        "source": "code_search",
        "_score": 20.0,
    }
    ranked = _rank_citations(
        [
            {**base, "file_id": 2, "file_path": "vendor/auth.min.js", "snippet": "function login_user token auth"},
            {**base, "file_id": 3, "file_path": "tests/test_auth.py", "snippet": "def test_login_user token auth"},
            {**base, "file_path": "src/auth.py", "snippet": "def login_user token auth"},
            {**base, "start_line": 2, "end_line": 5, "file_path": "src/auth.py", "snippet": "def login_user token auth"},
        ],
        ["auth"],
        ["login_user"],
    )

    assert ranked[0]["file_path"] == "src/auth.py"
    assert sum(item["file_path"] == "src/auth.py" for item in ranked) == 1
    assert ranked[-1]["file_path"] == "vendor/auth.min.js"


def test_model_reference_validation_removes_invalid_ids_and_adds_evidence_footer() -> None:
    citations = [
        {"file_path": "src/auth.py", "start_line": 10, "end_line": 14},
        {"file_path": "src/user.py", "start_line": 5, "end_line": 8},
    ]

    normalized = _normalize_model_references("登录入口在这里 [1]，不存在的引用 [9]。", citations)
    without_references = _normalize_model_references("登录入口可能在认证模块。", citations)

    assert "[1]" in normalized
    assert "[9]" not in normalized
    assert "[REFERENCE_CHECK_FAILED]" in without_references
    assert "src/auth.py:10-14" in without_references
    assert _valid_model_references("使用 [1] 和 [2]，忽略 [8]。", 2) == {1, 2}


def test_evidence_confidence_requires_traceable_high_quality_sources() -> None:
    exact = {
        "file_id": 1,
        "file_path": "src/auth.py",
        "source": "symbol_exact",
    }
    semantic = {
        "file_id": 2,
        "file_path": "src/session.py",
        "source": "semantic_search",
        "_semantic_score": 0.46,
    }

    assert _evidence_confidence([exact], ["location"]) == "high"
    assert _evidence_confidence([semantic], ["general"]) == "medium"
    assert _evidence_confidence([], ["general"]) == "low"


def test_evidence_gate_rejects_weak_semantic_matches_and_keeps_traceable_evidence() -> None:
    weak = {
        "file_id": 1,
        "file_path": "src/unrelated.py",
        "start_line": 1,
        "end_line": 3,
        "symbol_name": "unrelated",
        "snippet": "def unrelated(): pass",
        "source": "semantic_search",
        "_score": 30.0,
        "_semantic_score": 0.31,
    }
    exact = {
        **weak,
        "file_id": 2,
        "file_path": "src/auth.py",
        "symbol_name": "login_user",
        "snippet": "def login_user(): pass",
        "source": "symbol_exact",
        "_semantic_score": 0.0,
    }

    selected = _select_relevant_citations([weak, exact], ["location"], ["login_user"])

    assert selected == [exact]


def test_extracts_commands_and_database_entities_from_evidence() -> None:
    citations = [
        {
            "file_path": "package.json",
            "snippet": '"scripts": { "dev": "vite", "start": "node server.js" }',
            "source": "project_file",
        },
        {
            "file_path": "README.md",
            "snippet": (
                "This should make sense after reading Python dependencies.\n"
                "Run with `docker compose up --build`."
            ),
            "source": "project_file",
        },
    ]

    commands = [command for command, _ in _extract_startup_commands(citations)]
    assert "npm run dev" in commands
    assert "npm start" in commands
    assert "docker compose up --build" in commands
    assert all("make sense" not in command.lower() for command in commands)
    assert all("python dependencies" not in command.lower() for command in commands)
    assert _extract_database_entities(
        '__tablename__ = "users"\nSELECT * FROM audit_logs\nprisma.session.findMany()\n'
        'Read from the cache and join that result.\nclass Tenant(DataBaseModel):'
    ) == ["users", "audit_logs", "session", "Tenant"]
