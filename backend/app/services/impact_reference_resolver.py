"""Bounded, on-demand static call bindings from indexed source, never execution."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from sqlalchemy import LargeBinary, case, cast, func, or_, select
from sqlalchemy.orm import Session
from tree_sitter import Node, Parser

from app.models.analysis import CodeSymbol, ImportRelation, SearchChunk
from app.models.project import Project, ProjectFile
from app.services.code_parser import LANGUAGES
from app.services.repository_path_service import resolve_project_storage_path

MAX_REFERENCE_FILES = 48
MAX_TOTAL_SOURCE_BYTES = 16 * 1024 * 1024
MAX_FILE_SOURCE_BYTES = 2 * 1024 * 1024
MAX_SOURCE_CHUNKS = 240
MAX_REFERENCE_RESULTS = 24
MAX_SYNTAX_NODES = 60_000
MAX_CALL_SITES = 2_048
INDEX_CHUNK_CHAR_LIMIT = 16_000

FUNCTION_NODES = {
    "function_definition", "function_declaration", "generator_function_declaration",
    "function_expression", "generator_function", "arrow_function", "method_definition", "lambda",
}
CLASS_NODES = {"class_definition", "class_declaration"}


@dataclass(frozen=True)
class _Binding:
    kind: str
    file_id: int
    name: str = ""
    line: int | None = None
    prefix: tuple[str, ...] = ()


@dataclass
class _Scope:
    parent: _Scope | None
    name: str = ""
    kind: str = "module"
    start: int = 1
    end: int = 1
    bindings: dict[str, _Binding | None] = field(default_factory=dict)
    wildcard: bool = False

    def declare(self, name: str, binding: _Binding | None) -> None:
        if name:
            self.bindings[name] = binding if name not in self.bindings else None

    def lookup(self, name: str) -> tuple[bool, _Binding | None]:
        current: _Scope | None = self
        while current is not None:
            if name in current.bindings:
                return True, current.bindings[name]
            if current.wildcard:
                return True, None
            current = current.parent
        return False, None


@dataclass(frozen=True)
class _Call:
    parts: tuple[str, ...]
    line: int
    scope: _Scope


@dataclass
class _File:
    record: ProjectFile
    scope: _Scope = field(default_factory=lambda: _Scope(None))
    calls: list[_Call] = field(default_factory=list)
    exports: dict[str, str] = field(default_factory=dict)
    exports_uncertain: bool = False
    definitions: dict[str, _Scope] = field(default_factory=dict)
    complete: bool = False
    syntax_nodes: int = 0


class _Context:
    def __init__(self, database: Session, project_id: int):
        self.database = database
        self.project_id = project_id
        self.files: dict[int, _File | None] = {}
        self.bytes_read = 0
        self.symbols: dict[tuple[int, str, int | None], tuple[CodeSymbol, str] | None] = {}

    def symbol(self, file_id: int, name: str, line: int | None = None):
        key = file_id, name, line
        if key not in self.symbols:
            statement = (
                select(CodeSymbol, ProjectFile.relative_path)
                .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
                .where(
                    CodeSymbol.project_id == self.project_id,
                    ProjectFile.project_id == self.project_id,
                    CodeSymbol.file_id == file_id,
                    CodeSymbol.qualified_name == name,
                )
                .order_by(CodeSymbol.start_line, CodeSymbol.id)
                .limit(2)
            )
            if line is not None:
                statement = statement.where(CodeSymbol.start_line == line)
            rows = self.database.execute(statement).all()
            self.symbols[key] = (rows[0][0], str(rows[0][1])) if len(rows) == 1 else None
        return self.symbols[key]

    def _complete_indexed_source(self, record: ProjectFile, indexed_lines: dict[int, str]) -> dict[int, str] | None:
        """Recover legacy index gaps only from the exact, bounded indexed version."""
        expected_hash = record.content_hash or ""
        # Keep the extra EOF/oversize probe byte inside the whole-request budget.
        allowance = min(MAX_FILE_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES - self.bytes_read - 1)
        if len(expected_hash) != 64 or allowance <= 0:
            return None
        storage_path = self.database.scalar(select(Project.storage_path).where(Project.id == self.project_id))
        if not storage_path:
            return None
        try:
            root = resolve_project_storage_path(storage_path)
            path = (root / record.relative_path).resolve()
            path.relative_to(root)
            if not path.is_file():
                return None
            with path.open("rb") as stream:
                content = stream.read(allowance + 1)
        except (OSError, ValueError, RuntimeError):
            return None
        self.bytes_read += len(content)
        if len(content) > allowance or b"\x00" in content:
            return None
        if hashlib.sha256(content).hexdigest() != expected_hash.lower():
            return None
        try:
            full_lines = content.decode("utf-8").splitlines()
        except UnicodeDecodeError:
            return None
        if len(full_lines) != record.line_count:
            return None
        # A valid disk hash does not justify hiding conflicting indexed text.
        if any(not 1 <= number <= len(full_lines) or full_lines[number - 1] != text
               for number, text in indexed_lines.items()):
            return None
        return dict(enumerate(full_lines, 1))

    def file(self, file_id: int) -> _File | None:
        if file_id in self.files:
            return self.files[file_id]
        if len(self.files) >= MAX_REFERENCE_FILES or self.bytes_read >= MAX_TOTAL_SOURCE_BYTES:
            return None
        self.files[file_id] = None
        record = self.database.scalar(select(ProjectFile).where(
            ProjectFile.id == file_id, ProjectFile.project_id == self.project_id
        ))
        if record is None or record.extension.lower() not in LANGUAGES:
            return None
        result = _File(record)
        self.files[file_id] = result
        # Read cheap row metadata first; do not materialize 240 oversized source
        # strings before applying the per-file and whole-request byte budgets.
        statement = select(
            SearchChunk.id, SearchChunk.start_line, SearchChunk.end_line,
            func.length(cast(SearchChunk.content, LargeBinary)),
        ).where(SearchChunk.project_id == self.project_id, SearchChunk.file_id == file_id)
        half = MAX_SOURCE_CHUNKS // 2
        head = self.database.execute(statement.order_by(SearchChunk.start_line, SearchChunk.id).limit(half)).all()
        tail = self.database.execute(statement.order_by(
            SearchChunk.start_line.desc(), SearchChunk.id.desc()
        ).limit(half)).all() if len(head) == half else []
        allowance = min(MAX_FILE_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES - self.bytes_read)
        chosen: dict[int, tuple] = {}
        for index in range(max(len(head), len(tail))):
            for group in (head, tail):
                if index >= len(group):
                    continue
                row = group[index]
                if row.id in chosen or int(row[3] or 0) > allowance:
                    continue
                chosen[row.id] = tuple(row)
                allowance -= int(row[3] or 0)
        if not chosen:
            return result
        lines: dict[int, str] = {}
        conflict = False
        chunks = self.database.execute(select(
            SearchChunk.id, SearchChunk.start_line, SearchChunk.end_line,
            func.length(cast(SearchChunk.content, LargeBinary)).label("source_bytes"),
            func.substr(
                cast(func.substr(SearchChunk.content, 1, INDEX_CHUNK_CHAR_LIMIT), LargeBinary),
                1, case({key: int(row[3] or 0) for key, row in chosen.items()}, value=SearchChunk.id, else_=0),
            ).label("content_bytes"),
        ).where(
            SearchChunk.project_id == self.project_id,
            SearchChunk.file_id == file_id,
            SearchChunk.id.in_(chosen),
        ).order_by(SearchChunk.start_line, SearchChunk.id))
        for chunk in chunks:
            self.bytes_read += len(chunk.content_bytes)
            metadata = chosen[chunk.id]
            if (chunk.start_line, chunk.end_line, chunk.source_bytes) != tuple(metadata[1:]):
                conflict = True  # index changed between metadata and bounded source reads
            try:
                content = chunk.content_bytes.decode("utf-8")
            except UnicodeDecodeError:
                conflict = True
                content = chunk.content_bytes.decode("utf-8", errors="replace")
            source_lines = content.split("\n")
            if len(content) == INDEX_CHUNK_CHAR_LIMIT or len(chunk.content_bytes) != chunk.source_bytes:
                conflict = True
                source_lines = source_lines[:-1]  # possible cut in the last line
            for line_number, text in enumerate(source_lines, chunk.start_line):
                if line_number > chunk.end_line and text:
                    conflict = True
                    continue
                # The producer's splitlines()-based end_line omits a trailing
                # blank line. A literal newline in content proves that blank;
                # never fill any other absent line between indexed windows.
                if line_number in lines and lines[line_number] != text:
                    conflict = True
                lines[line_number] = text
        ordered = sorted(lines)
        result.complete = bool(ordered) and not conflict and (
            ordered[0] == 1 and ordered[-1] == record.line_count and len(ordered) == record.line_count
        )
        if not conflict and ordered and len(ordered) < record.line_count and (
            1 <= ordered[0] <= ordered[-1] <= record.line_count
        ):
            recovered = self._complete_indexed_source(record, lines)
            if recovered is not None:
                lines = recovered
                ordered = sorted(lines)
                result.complete = True
        relations = self.database.execute(
            select(ImportRelation.target_module, ImportRelation.line_number, ImportRelation.resolved_file_id)
            .join(ProjectFile, ProjectFile.id == ImportRelation.resolved_file_id)
            .where(
                ImportRelation.project_id == self.project_id,
                ImportRelation.file_id == file_id,
                ProjectFile.project_id == self.project_id,
            )
            .order_by(ImportRelation.line_number, ImportRelation.id)
            .limit(MAX_SOURCE_CHUNKS)
        ).all()
        bindings: dict[tuple[int, str], set[int]] = {}
        for module, line, resolved_id in relations:
            bindings.setdefault((line, module), set()).add(resolved_id)
        parser = Parser(LANGUAGES[record.extension.lower()])
        groups: list[list[int]] = []
        for line in ordered:
            if not groups or line != groups[-1][-1] + 1:
                groups.append([])
            groups[-1].append(line)
        for group in groups:
            source = "\n".join(lines[line] for line in group).encode("utf-8")
            tree = parser.parse(source)
            if tree.root_node.has_error:
                result.complete = False
            # Never fabricate blank lines across missing source. Separate partial
            # parses can supply low-confidence candidates, never verified calls.
            _walk_file(result, tree.root_node, source, group[0] - 1, bindings)
        return result


def _text(node: Node | None, source: bytes) -> str:
    return source[node.start_byte:node.end_byte].decode("utf-8", errors="replace") if node else ""


def _has_type_modifier(node: Node) -> bool:
    # Inspect the grammar token, not source text: comments may separate the
    # keywords, and a value identifier/alias named "type" is still executable.
    return any(child.type == "type" and not child.is_named for child in node.children)


def _names(node: Node | None, source: bytes) -> list[str]:
    pending = [node] if node is not None else []
    names: list[str] = []
    visited = 0
    while pending:
        item = pending.pop()
        visited += 1
        if visited > MAX_SYNTAX_NODES:
            raise RecursionError("Binding pattern exceeds the bounded syntax budget")
        if item.type in {"identifier", "shorthand_property_identifier_pattern"}:
            names.append(_text(item, source))
            continue
        if item.type == "pair_pattern":
            child = item.child_by_field_name("value")
        else:
            child = next((value for name in ("pattern", "name", "left")
                          if (value := item.child_by_field_name(name)) is not None), None)
        pending.extend([child] if child is not None else reversed(item.named_children))
    return names


def _parts(node: Node | None, source: bytes) -> tuple[str, ...]:
    suffix: list[str] = []
    while node is not None and node.type in {"attribute", "member_expression"}:
        if len(suffix) >= MAX_SYNTAX_NODES:
            raise RecursionError("Member chain exceeds the bounded syntax budget")
        member = node.child_by_field_name("attribute") or node.child_by_field_name("property")
        if member is None or member.type not in {"identifier", "property_identifier"}:
            return ()
        suffix.append(_text(member, source))
        node = node.child_by_field_name("object")
    if node is not None and node.type in {"identifier", "property_identifier"}:
        return (_text(node, source), *reversed(suffix))
    return ()


def _walk_file(file: _File, root: Node, source: bytes, offset: int, imports: dict) -> None:
    python = file.record.extension.lower() == ".py"

    def resolved(module: str, line: int) -> int | None:
        matches = imports.get((line, module), set())
        return next(iter(matches)) if len(matches) == 1 else None

    def imported(scope: _Scope, name: str, module: str, line: int, target: str = "", prefix=(), commonjs=False):
        target_id = resolved(module, line)
        kind = "symbol" if target else "commonjs" if commonjs else "module"
        scope.declare(name, _Binding(kind, target_id, target, prefix=prefix)
                      if target_id is not None else None)

    def visit(node: Node, scope: _Scope, parents: tuple[str, ...], declared=None):
        file.syntax_nodes += 1
        if file.syntax_nodes > MAX_SYNTAX_NODES:
            file.complete = False
            return
        line = node.start_point.row + offset + 1
        kind = node.type
        if kind in FUNCTION_NODES | CLASS_NODES:
            name_node = node.child_by_field_name("name")
            name = declared[0] if declared else _text(name_node, source)
            definition_line = declared[1] if declared else line
            qualified = ".".join((*parents, name)) if name else ".".join((*parents, f"<anonymous:{line}>"))
            if name and declared is None and kind != "method_definition":
                scope.declare(name, _Binding("definition", file.record.id, qualified, definition_line))
            parent = scope.parent if kind in FUNCTION_NODES and scope.kind == "class" else scope
            child_scope = _Scope(parent, qualified, "class" if kind in CLASS_NODES else "function",
                                 definition_line, node.end_point.row + offset + 1)
            file.definitions[qualified] = child_scope
            parameters = node.child_by_field_name("parameters") or node.child_by_field_name("parameter")
            for parameter in _names(parameters, source):
                child_scope.declare(parameter, None)
            body = node.child_by_field_name("body")
            if body is not None:
                visit(body, child_scope, (*parents, name) if name else parents)
            return
        if not python and kind == "statement_block":
            scope = _Scope(scope, scope.name, "block", scope.start, scope.end)
        if not python and kind == "catch_clause":
            scope = _Scope(scope, scope.name, "block", scope.start, scope.end)
            for name in _names(node.child_by_field_name("parameter"), source):
                scope.declare(name, None)
        if python and kind in {"as_pattern", "named_expression"}:
            pattern = node.child_by_field_name("alias" if kind == "as_pattern" else "name")
            for name in _names(pattern, source):
                scope.declare(name, None)
        subscription_delete = (python and kind == "delete_statement" and node.named_children
                               and all(child.type == "subscript" for child in node.named_children))
        if kind in {"global_statement", "nonlocal_statement", "delete_statement", "with_statement"} and not (
            python and kind == "with_statement"
        ) and not subscription_delete:
            # These alter name resolution outside the ordinary lexical scope.
            # Do not pretend the simple static binding model can prove them.
            file.complete = False
        if python and kind in {"import_statement", "import_from_statement"}:
            module_node = node.child_by_field_name("module_name")
            module = _text(module_node, source)
            for child in node.named_children:
                if child == module_node:
                    continue
                if child.type == "wildcard_import":
                    scope.wildcard = True
                    continue
                name_node = child.child_by_field_name("name") if child.type == "aliased_import" else child
                target = _text(name_node, source)
                alias = _text(child.child_by_field_name("alias"), source)
                if kind == "import_from_statement":
                    imported(scope, alias or target, module, line, target)
                else:
                    parts = target.split(".")
                    imported(scope, alias or parts[0], target, line, prefix=tuple(parts[1:]) if not alias else ())
            return
        if not python and kind == "import_statement":
            if _has_type_modifier(node):
                return  # TypeScript import type declarations are erased at runtime.
            module = _text(node.child_by_field_name("source"), source).strip("'\"")
            clause = next((item for item in node.named_children if item.type == "import_clause"), None)
            if clause is not None:
                for child in clause.named_children:
                    if child.type == "identifier":
                        imported(scope, _text(child, source), module, line, "default")
                    elif child.type == "namespace_import":
                        imported(scope, _text(child.named_children[-1], source), module, line)
                    elif child.type == "named_imports":
                        for specifier in child.named_children:
                            if _has_type_modifier(specifier):
                                continue
                            name = _text(specifier.child_by_field_name("name"), source)
                            alias = _text(specifier.child_by_field_name("alias"), source)
                            imported(scope, alias or name, module, line, name)
            return
        if not python and kind == "export_statement":
            declaration = node.child_by_field_name("declaration")
            if _has_type_modifier(node) or (
                declaration is not None and declaration.type in {"type_alias_declaration", "interface_declaration"}
            ):
                # Type/value namespaces can share a name. Exporting that type
                # does not expose a private same-name function or remove an
                # independently declared runtime export.
                return
            if declaration is not None:
                name = _text(declaration.child_by_field_name("name"), source)
                if name:
                    file.exports["default" if _text(node, source).lstrip().startswith("export default") else name] = name
                for child in declaration.named_children:
                    if child.type == "variable_declarator":
                        for value in _names(child.child_by_field_name("name"), source):
                            file.exports[value] = value
            elif node.child_by_field_name("source") is None:
                for clause in node.named_children:
                    if clause.type == "export_clause":
                        for specifier in clause.named_children:
                            if _has_type_modifier(specifier):
                                continue
                            name = _text(specifier.child_by_field_name("name"), source)
                            alias = _text(specifier.child_by_field_name("alias"), source)
                            file.exports[alias or name] = name
        if kind == "variable_declarator":
            if node.parent is not None and node.parent.type == "variable_declaration":
                while scope.parent is not None and scope.kind == "block":
                    scope = scope.parent  # JavaScript var is function-scoped, not block-scoped
            name_node, value = node.child_by_field_name("name"), node.child_by_field_name("value")
            names = _names(name_node, source)
            if len(names) == 1 and value is not None and value.type in FUNCTION_NODES:
                scope.declare(names[0], _Binding("definition", file.record.id, ".".join((*parents, names[0])), line))
                visit(value, scope, parents, (names[0], line))
                return
            if value is not None and value.type == "call_expression" and _text(value.child_by_field_name("function"), source) == "require":
                arguments = value.child_by_field_name("arguments")
                first = arguments.named_children[0] if arguments and arguments.named_children else None
                module = _text(first, source).strip("'\"") if first and first.type == "string" else ""
                import_line = value.start_point.row + offset + 1
                if scope.lookup("require")[0]:
                    for name in names:
                        scope.declare(name, None)
                    return  # a local require parameter/declaration is not the CommonJS loader
                if name_node is not None and name_node.type == "identifier":
                    imported(scope, names[0], module, import_line, commonjs=True)
                elif name_node is not None and name_node.type == "object_pattern":
                    for child in name_node.named_children:
                        if child.type == "pair_pattern":
                            target = _text(child.child_by_field_name("key"), source)
                            for alias in _names(child.child_by_field_name("value"), source):
                                imported(scope, alias, module, import_line, target)
                        else:
                            for alias in _names(child, source):
                                imported(scope, alias, module, import_line, alias)
                return
            for name in names:
                scope.declare(name, None)
        if kind in {"assignment", "augmented_assignment", "assignment_expression", "augmented_assignment_expression"}:
            left, right = node.child_by_field_name("left"), node.child_by_field_name("right")
            chain = _parts(left, source)
            prototype_owner = chain[:2] if len(chain) >= 3 else (
                _parts(left.child_by_field_name("object"), source)
                if left is not None and left.type == "subscript_expression" else ()
            )
            export_root = left
            while export_root is not None and export_root.type in {"member_expression", "subscript_expression"}:
                export_root = export_root.child_by_field_name("object")
            root_name = _text(export_root, source) if export_root is not None and export_root.type == "identifier" else ""
            builtin_export = (not python and root_name in {"module", "exports"}
                              and not scope.lookup(root_name)[0])
            if builtin_export and (not chain or scope is not file.scope):
                # Dynamic property writes and deferred/conditional export writes
                # cannot establish a stable module-level callable export.
                file.exports_uncertain = True
                file.exports.clear()
            stable_export = builtin_export and scope is file.scope and bool(chain)
            if stable_export and chain == ("module", "exports"):
                # Replacing the export object invalidates all prior named/default
                # mappings, including assignments to objects or anonymous values.
                file.exports.clear()
            elif stable_export and chain[:2] == ("module", "exports") and len(chain) >= 3:
                file.exports.pop(chain[2], None)
            elif stable_export and chain[:1] == ("exports",) and len(chain) >= 2:
                file.exports.pop(chain[1], None)
            if stable_export and kind == "assignment_expression" and right is not None and right.type == "identifier":
                if chain[:2] == ("module", "exports") and len(chain) in {2, 3}:
                    file.exports[chain[2] if len(chain) == 3 else "default"] = _text(right, source)
                elif len(chain) == 2 and chain[0] == "exports" and "default" not in file.exports:
                    file.exports[chain[1]] = _text(right, source)
            for name in _names(left, source) if not chain else chain[:1]:
                owner = scope
                if not python:
                    while owner.parent is not None and name not in owner.bindings:
                        owner = owner.parent
                if builtin_export and chain and len(chain) > 1:
                    continue  # changing an export property does not rebind module/exports
                if not python and owner is file.scope and name in {"module", "exports"}:
                    file.exports_uncertain = True
                if (not python and prototype_owner == (name, "prototype")
                        and (binding := owner.bindings.get(name)) is not None
                        and binding.kind == "definition"):
                    # Writing Constructor.prototype.method does not reassign the
                    # constructor variable. This does not resolve prototype calls:
                    # those receivers/method paths remain unsupported below.
                    continue
                owner.declare(name, None)
        if kind in {"for_statement", "for_in_clause", "for_in_statement"}:
            for name in _names(node.child_by_field_name("left"), source):
                scope.declare(name, None)
        if kind in {"call", "call_expression", "new_expression"}:
            callee = node.child_by_field_name("function") or node.child_by_field_name("constructor")
            parts = _parts(callee, source)
            if parts in {("eval",), ("exec",)}:
                file.complete = False
            if parts and len(file.calls) < MAX_CALL_SITES:
                file.calls.append(_Call(parts, line, scope))
        for child in node.named_children:
            visit(child, scope, parents)

    try:
        visit(root, file.scope, ())
    except RecursionError:
        file.complete = False


def _bound_target(context: _Context, file: _File, call: _Call):
    found, binding = call.scope.lookup(call.parts[0])
    if not found:
        # Sparse index-only fixtures and clipped long functions may retain a
        # known same-file definition, but cannot prove that local shadowing is
        # absent. This fallback is never accepted as an incoming bound call.
        candidate = context.symbol(file.record.id, call.parts[0]) if len(call.parts) == 1 else None
        return (candidate, False) if candidate else (None, False)
    if binding is None:
        return None, False
    if not file.complete and binding.file_id != file.record.id:
        # A sparse fragment cannot prove the module import still governs the
        # call's lexical scope. Only same-file definitions may remain candidates.
        return None, False
    remaining = call.parts[1:]
    if binding.kind in {"module", "commonjs"}:
        if tuple(remaining[:len(binding.prefix)]) != binding.prefix:
            return None, False
        remaining = remaining[len(binding.prefix):]
        if not remaining:
            if binding.kind != "commonjs":
                return None, False  # ES module namespace objects are not callable
            name = "default"
        else:
            name = ".".join(remaining)
    else:
        name = binding.name
        if remaining:
            base = context.symbol(binding.file_id, name, binding.line)
            if base is None or base[0].kind != "class":
                return None, False
            name += "." + ".".join(remaining)
    target_line = binding.line if not remaining and binding.kind == "definition" else None
    if binding.file_id != file.record.id:
        destination = context.file(binding.file_id)
        if destination is None or not destination.complete:
            return None, False
        pieces = name.split(".")
        if file.record.extension != ".py":
            if destination.exports_uncertain or (
                binding.kind == "commonjs" and destination.scope.lookup("module")[0]
            ):
                return None, False
            exported = destination.exports.get(pieces[0])
            if exported is None:
                return None, False
            pieces = [exported, *pieces[1:]]
        # An indexed definition may subsequently be reassigned or shadowed.
        # Imports must bind to the final, unique local declaration, not just a
        # same-name CodeSymbol. Re-exports/dynamic module attributes stay unknown.
        final_binding = destination.scope.bindings.get(pieces[0])
        if final_binding is None or final_binding.kind != "definition":
            return None, False
        for member in pieces[1:]:
            definition_scope = destination.definitions.get(final_binding.name)
            final_binding = definition_scope.bindings.get(member) if definition_scope else None
            if final_binding is None or final_binding.kind != "definition":
                return None, False
        name, target_line = final_binding.name, final_binding.line
    target = context.symbol(binding.file_id, name, target_line)
    return target, file.complete


def resolve_called_symbols(database: Session, symbol: CodeSymbol) -> list[dict[str, object]]:
    return _called_symbols(_Context(database, symbol.project_id), symbol)


def _called_symbols(context: _Context, symbol: CodeSymbol) -> list[dict[str, object]]:
    source = context.file(symbol.file_id)
    if source is None:
        return []
    results: dict[int, dict[str, object]] = {}
    for call in source.calls:
        if not symbol.start_line <= call.line <= symbol.end_line:
            continue
        target, certain = _bound_target(context, source, call)
        if target is None or target[0].id == symbol.id:
            continue
        candidate, path = target
        relation = {
            "file_id": candidate.file_id, "file_path": path,
            "relation": "bound_symbol_call" if certain else "candidate_symbol_call",
            "confidence": "high" if certain else "low", "depth": 1,
            "line_numbers": [candidate.start_line], "symbol_id": candidate.id,
            "symbol_name": candidate.qualified_name, "symbol_kind": candidate.kind,
            "start_line": candidate.start_line, "end_line": candidate.end_line,
        }
        if candidate.id not in results or certain:
            results[candidate.id] = relation
        if len(results) >= MAX_REFERENCE_RESULTS:
            break
    return list(results.values())


def resolve_symbol_references(database: Session, symbol: CodeSymbol) -> list[dict[str, object]]:
    return _symbol_references(_Context(database, symbol.project_id), symbol)


def resolve_symbol_relations(
    database: Session, symbol: CodeSymbol,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Resolve both directions under ONE per-request source/parse budget."""
    context = _Context(database, symbol.project_id)
    # Reserve the selected source first so incoming candidates cannot exhaust
    # the shared budget before outgoing analysis has inspected its own scope.
    called = _called_symbols(context, symbol)
    return _symbol_references(context, symbol), called


def _symbol_references(context: _Context, symbol: CodeSymbol) -> list[dict[str, object]]:
    incoming = select(ImportRelation.file_id).where(
        ImportRelation.project_id == symbol.project_id,
        ImportRelation.resolved_file_id == symbol.file_id,
    )
    files = context.database.scalars(select(ProjectFile.id).where(
        ProjectFile.project_id == symbol.project_id,
        or_(ProjectFile.id == symbol.file_id, ProjectFile.id.in_(incoming)),
    ).order_by(ProjectFile.relative_path, ProjectFile.id).limit(MAX_REFERENCE_FILES))
    results: dict[tuple[int, str], dict[str, object]] = {}
    for file_id in files:
        source = context.file(file_id)
        if source is None or not source.complete:
            continue
        for call in source.calls:
            target, certain = _bound_target(context, source, call)
            if not certain or target is None or target[0].id != symbol.id:
                continue
            key = file_id, call.scope.name
            if key not in results:
                caller = context.symbol(file_id, call.scope.name, call.scope.start) if call.scope.name else None
                results[key] = {
                    "file_id": file_id, "file_path": source.record.relative_path,
                    "relation": "bound_symbol_call", "confidence": "high", "depth": 1,
                    "line_numbers": [], "symbol_id": caller[0].id if caller else None,
                    "symbol_name": call.scope.name or None,
                    "symbol_kind": caller[0].kind if caller else "module",
                    "start_line": call.scope.start if caller else call.line,
                    "end_line": call.scope.end if caller else call.line,
                }
            if call.line not in results[key]["line_numbers"]:
                results[key]["line_numbers"].append(call.line)
        if len(results) >= MAX_REFERENCE_RESULTS:
            break
    return list(results.values())[:MAX_REFERENCE_RESULTS]
