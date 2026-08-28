from app.services.code_parser import parse_source, supports_extension


def test_parses_python_symbols_and_imports() -> None:
    source = b"""import os, json as json_lib
from app.models import User

class UserService:
    def create_user(self, name):
        return User(name=name)

def health_check():
    return True
"""

    result = parse_source(source, ".py")

    assert [(item.qualified_name, item.kind) for item in result.symbols] == [
        ("UserService", "class"),
        ("UserService.create_user", "method"),
        ("health_check", "function"),
    ]
    assert [(item.target_module, item.line_number) for item in result.imports] == [
        ("os", 1),
        ("json", 1),
        ("app.models", 2),
    ]
    assert result.has_syntax_errors is False


def test_parses_typescript_symbols_and_imports() -> None:
    source = b"""import { User } from './models/user';
const path = require('node:path');

interface Repository { find(): User }
class UserService {
  findUser(): User { return {} as User; }
}
const createUser = (name: string) => ({ name });
"""

    result = parse_source(source, ".ts")

    assert [(item.name, item.kind) for item in result.symbols] == [
        ("Repository", "interface"),
        ("find", "method"),
        ("UserService", "class"),
        ("findUser", "method"),
        ("createUser", "function"),
    ]
    assert [item.target_module for item in result.imports] == ["./models/user", "node:path"]


def test_reports_unsupported_extensions() -> None:
    assert supports_extension(".java") is False
    assert supports_extension(".tsx") is True
