import re
from dataclasses import dataclass

import tree_sitter_python
import tree_sitter_typescript
from tree_sitter import Language, Node, Parser


PYTHON_LANGUAGE = Language(tree_sitter_python.language())
TYPESCRIPT_LANGUAGE = Language(tree_sitter_typescript.language_typescript())
TSX_LANGUAGE = Language(tree_sitter_typescript.language_tsx())

LANGUAGES = {
    ".py": PYTHON_LANGUAGE,
    ".js": TYPESCRIPT_LANGUAGE,
    ".jsx": TSX_LANGUAGE,
    ".ts": TYPESCRIPT_LANGUAGE,
    ".tsx": TSX_LANGUAGE,
}


@dataclass(frozen=True)
class ParsedSymbol:
    name: str
    qualified_name: str
    kind: str
    start_line: int
    end_line: int


@dataclass(frozen=True)
class ParsedImport:
    target_module: str
    line_number: int


@dataclass(frozen=True)
class ParseResult:
    symbols: list[ParsedSymbol]
    imports: list[ParsedImport]
    has_syntax_errors: bool


def supports_extension(extension: str) -> bool:
    return extension.lower() in LANGUAGES


def parse_source(source: bytes, extension: str) -> ParseResult:
    language = LANGUAGES.get(extension.lower())
    if language is None:
        raise ValueError(f"Unsupported source extension: {extension}")

    parser = Parser(language)
    tree = parser.parse(source)
    symbols: list[ParsedSymbol] = []
    imports: list[ParsedImport] = []
    _walk(tree.root_node, source, extension.lower(), [], symbols, imports)

    unique_imports = list(dict.fromkeys(imports))
    return ParseResult(
        symbols=symbols,
        imports=unique_imports,
        has_syntax_errors=tree.root_node.has_error,
    )


def _walk(
    node: Node,
    source: bytes,
    extension: str,
    parents: list[tuple[str, str]],
    symbols: list[ParsedSymbol],
    imports: list[ParsedImport],
) -> None:
    symbol = _extract_symbol(node, source, extension, parents)
    next_parents = parents
    if symbol is not None:
        symbols.append(symbol)
        next_parents = [*parents, (symbol.name, symbol.kind)]

    imported_targets = _extract_imports(node, source, extension)
    imports.extend(
        ParsedImport(target_module=target, line_number=node.start_point.row + 1)
        for target in imported_targets
    )
    for child in node.named_children:
        _walk(child, source, extension, next_parents, symbols, imports)


def _extract_symbol(
    node: Node,
    source: bytes,
    extension: str,
    parents: list[tuple[str, str]],
) -> ParsedSymbol | None:
    node_kind: str | None = None
    name_node: Node | None = None

    if extension == ".py":
        if node.type == "class_definition":
            node_kind = "class"
            name_node = node.child_by_field_name("name")
        elif node.type == "function_definition":
            node_kind = "method" if any(kind == "class" for _, kind in parents) else "function"
            name_node = node.child_by_field_name("name")
    else:
        type_to_kind = {
            "class_declaration": "class",
            "interface_declaration": "interface",
            "function_declaration": "function",
            "generator_function_declaration": "function",
            "method_definition": "method",
            "method_signature": "method",
        }
        node_kind = type_to_kind.get(node.type)
        if node_kind is not None:
            name_node = node.child_by_field_name("name")
        elif node.type == "variable_declarator":
            value = node.child_by_field_name("value")
            if value is not None and value.type in {"arrow_function", "function_expression"}:
                node_kind = "function"
                name_node = node.child_by_field_name("name")

    if node_kind is None or name_node is None:
        return None

    name = _node_text(name_node, source).strip()
    if not name:
        return None
    qualified_name = ".".join([*(parent_name for parent_name, _ in parents), name])
    return ParsedSymbol(
        name=name,
        qualified_name=qualified_name,
        kind=node_kind,
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
    )


def _extract_imports(node: Node, source: bytes, extension: str) -> list[str]:
    text = _node_text(node, source).strip()
    if extension == ".py":
        if node.type == "import_statement":
            imported = text.removeprefix("import ")
            return [part.split(" as ", 1)[0].strip() for part in imported.split(",") if part.strip()]
        if node.type == "import_from_statement":
            match = re.match(r"from\s+([.\w]+)\s+import\s+", text, re.DOTALL)
            return [match.group(1)] if match else []
        return []

    if node.type == "import_statement":
        match = re.search(r"(?:from\s*)?['\"]([^'\"]+)['\"]", text)
        return [match.group(1)] if match else []
    if node.type == "call_expression":
        function = node.child_by_field_name("function")
        arguments = node.child_by_field_name("arguments")
        if function is not None and arguments is not None and _node_text(function, source) == "require":
            match = re.search(r"['\"]([^'\"]+)['\"]", _node_text(arguments, source))
            return [match.group(1)] if match else []
    return []


def _node_text(node: Node, source: bytes) -> str:
    return source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")
