from typing import Any

import pytest

from app.services import report_provider_service


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.payload


@pytest.mark.parametrize(
    ("provider_id", "payload", "expected_text", "endpoint"),
    [
        (
            "openai-chat-compatible",
            {"choices": [{"message": {"content": "chat answer"}}]},
            "chat answer",
            "/chat/completions",
        ),
        (
            "anthropic",
            {"content": [{"type": "text", "text": "claude answer"}]},
            "claude answer",
            "/messages",
        ),
        (
            "gemini",
            {"candidates": [{"content": {"parts": [{"text": "gemini answer"}]}}]},
            "gemini answer",
            "/models/test-model:generateContent",
        ),
    ],
)
def test_generates_text_with_additional_provider_protocols(
    monkeypatch: pytest.MonkeyPatch,
    provider_id: str,
    payload: dict[str, Any],
    expected_text: str,
    endpoint: str,
) -> None:
    captured: dict[str, Any] = {}

    def fake_post(url: str, **kwargs: Any) -> FakeResponse:
        captured.update({"url": url, **kwargs})
        return FakeResponse(payload)

    monkeypatch.setattr(report_provider_service.httpx, "post", fake_post)
    content = report_provider_service._generate_provider_text(
        provider_id,
        {
            "base_url": "https://provider.example/v1",
            "model": "test-model",
            "api_key": "secret",
        },
        instructions="system rules",
        prompt="repository evidence",
        max_output_tokens=512,
        timeout=30.0,
    )

    assert content == expected_text
    assert captured["url"].endswith(endpoint)
    assert captured["timeout"] == 30.0
    assert "secret" not in str(captured["json"])


def test_gemini_model_prefix_is_normalized() -> None:
    assert report_provider_service._gemini_model_name("models/gemini-flash") == "gemini-flash"
