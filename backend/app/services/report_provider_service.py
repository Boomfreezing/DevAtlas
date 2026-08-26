import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import Settings


PROVIDER_DEFINITIONS = {
    "local": {
        "name": "本地智能分析",
        "description": "综合代码结构、依赖图谱与质量规则生成针对性报告。",
        "endpoint": "/api/projects/{project_id}/report?generator=local",
        "cost_label": "免费 · 默认",
        "requires_configuration": False,
    },
    "ollama": {
        "name": "Ollama 本地模型服务",
        "description": "连接本机或局域网部署的 Ollama 服务，使用已下载的本地模型增强报告。",
        "endpoint": "/api/generate",
        "cost_label": "免费 · 本地运行",
        "requires_configuration": True,
    },
    "openai-compatible": {
        "name": "OpenAI Responses API",
        "description": "连接 OpenAI 官方或实现 Responses 协议的兼容网关；不直接支持 DeepSeek、Claude 原生 API。",
        "endpoint": "/responses",
        "cost_label": "按供应商计费",
        "requires_configuration": True,
    },
}

DEFAULT_CONFIGS: dict[str, dict[str, Any]] = {
    "ollama": {
        "base_url": "http://127.0.0.1:11434",
        "model": "",
        "api_key": "",
        "connection_status": "untested",
        "connection_message": "尚未测试连接",
        "tested_at": None,
    },
    "openai-compatible": {
        "base_url": "https://api.openai.com/v1",
        "model": "",
        "api_key": "",
        "connection_status": "untested",
        "connection_message": "尚未测试连接",
        "tested_at": None,
    },
}


class ReportProviderError(RuntimeError):
    pass


def list_report_providers(settings: Settings) -> list[dict[str, object]]:
    configs = _read_configs(settings.provider_config_path)
    providers: list[dict[str, object]] = []
    for provider_id, definition in PROVIDER_DEFINITIONS.items():
        if provider_id == "local":
            providers.append(
                {
                    "id": provider_id,
                    **definition,
                    "available": True,
                    "configured": True,
                    "base_url": "local://rule-engine",
                    "model": "DevAtlas Rules",
                    "has_api_key": False,
                    "connection_status": "ready",
                    "connection_message": "本地规则引擎已就绪",
                    "tested_at": None,
                }
            )
            continue
        config = configs[provider_id]
        configured = _is_configured(provider_id, config)
        providers.append(
            {
                "id": provider_id,
                **definition,
                "available": configured,
                "configured": configured,
                "base_url": config["base_url"],
                "model": config["model"],
                "has_api_key": bool(config["api_key"]),
                "connection_status": config["connection_status"],
                "connection_message": config["connection_message"],
                "tested_at": config["tested_at"],
            }
        )
    return providers


def save_report_provider(
    settings: Settings,
    provider_id: str,
    *,
    base_url: str,
    model: str,
    api_key: str | None,
) -> dict[str, object]:
    _require_configurable_provider(provider_id)
    normalized_url = _validate_base_url(base_url)
    normalized_model = model.strip()
    if not normalized_model:
        raise ReportProviderError("模型名称不能为空。")

    configs = _read_configs(settings.provider_config_path)
    config = configs[provider_id]
    config["base_url"] = normalized_url
    config["model"] = normalized_model
    if api_key is not None and api_key.strip():
        config["api_key"] = api_key.strip()
    if provider_id == "openai-compatible" and not config["api_key"]:
        raise ReportProviderError("OpenAI Responses API 需要填写 API Key。")
    config["connection_status"] = "untested"
    config["connection_message"] = "配置已保存，等待连接测试"
    config["tested_at"] = None
    _write_configs(settings.provider_config_path, configs)
    return _provider_by_id(settings, provider_id)


def test_report_provider(settings: Settings, provider_id: str) -> dict[str, object]:
    _require_configurable_provider(provider_id)
    configs = _read_configs(settings.provider_config_path)
    config = configs[provider_id]
    if not _is_configured(provider_id, config):
        raise ReportProviderError("请先填写并保存完整配置。")

    try:
        if provider_id == "ollama":
            response = httpx.get(f"{config['base_url']}/api/tags", timeout=8.0)
            response.raise_for_status()
            installed = [item.get("name", "") for item in response.json().get("models", [])]
            if config["model"] not in installed:
                message = f"服务连接成功，但未发现模型 {config['model']}。"
                ok = False
            else:
                message = f"Ollama 连接成功，模型 {config['model']} 可用。"
                ok = True
        else:
            headers = {"Authorization": f"Bearer {config['api_key']}"}
            response = httpx.get(f"{config['base_url']}/models", headers=headers, timeout=12.0)
            response.raise_for_status()
            message = "API 认证与服务地址验证成功。"
            ok = True
    except (httpx.HTTPError, ValueError) as error:
        ok = False
        message = _safe_connection_message(error)

    config["connection_status"] = "success" if ok else "failed"
    config["connection_message"] = message
    config["tested_at"] = datetime.now(UTC).isoformat()
    _write_configs(settings.provider_config_path, configs)
    return {"ok": ok, "message": message, "provider": _provider_by_id(settings, provider_id)}


def enhance_markdown_report(
    settings: Settings, provider_id: str, local_report: str
) -> str:
    _require_configurable_provider(provider_id)
    config = _read_configs(settings.provider_config_path)[provider_id]
    if not _is_configured(provider_id, config):
        raise ReportProviderError("所选分析接口尚未完成配置。")

    instructions = (
        "你是资深代码审查与软件架构专家。基于 DevAtlas 已生成的事实报告，"
        "强化其中的智能分析结论和建议，使建议具体、可执行且与指标一致。"
        "保留项目数据表格，不要虚构未提供的代码事实。只返回完整 Markdown，不要使用代码围栏。"
    )
    prompt = f"请生成最终代码仓库分析报告：\n\n{local_report[:60_000]}"
    try:
        if provider_id == "ollama":
            response = httpx.post(
                f"{config['base_url']}/api/generate",
                json={
                    "model": config["model"],
                    "system": instructions,
                    "prompt": prompt,
                    "stream": False,
                },
                timeout=180.0,
            )
            response.raise_for_status()
            content = str(response.json().get("response", ""))
        else:
            response = httpx.post(
                f"{config['base_url']}/responses",
                headers={
                    "Authorization": f"Bearer {config['api_key']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": config["model"],
                    "instructions": instructions,
                    "input": prompt,
                    "store": False,
                    "max_output_tokens": 8_000,
                },
                timeout=180.0,
            )
            response.raise_for_status()
            content = _extract_responses_text(response.json())
    except (httpx.HTTPError, ValueError) as error:
        raise ReportProviderError(_safe_connection_message(error)) from error

    content = _strip_markdown_fence(content.strip())
    if not content:
        raise ReportProviderError("模型返回了空报告。")
    return content + "\n"


def _provider_by_id(settings: Settings, provider_id: str) -> dict[str, object]:
    return next(item for item in list_report_providers(settings) if item["id"] == provider_id)


def _read_configs(path: Path) -> dict[str, dict[str, Any]]:
    configs = {key: dict(value) for key, value in DEFAULT_CONFIGS.items()}
    if not path.exists():
        return configs
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return configs
    for provider_id in configs:
        value = stored.get(provider_id)
        if isinstance(value, dict):
            configs[provider_id].update(
                {key: item for key, item in value.items() if key in configs[provider_id]}
            )
    return configs


def _write_configs(path: Path, configs: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(configs, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _validate_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ReportProviderError("API 地址必须是完整的 http:// 或 https:// URL。")
    return normalized


def _require_configurable_provider(provider_id: str) -> None:
    if provider_id not in DEFAULT_CONFIGS:
        raise ReportProviderError("该报告接口不存在或不需要配置。")


def _is_configured(provider_id: str, config: dict[str, Any]) -> bool:
    complete = bool(config["base_url"] and config["model"])
    return complete and (provider_id != "openai-compatible" or bool(config["api_key"]))


def _safe_connection_message(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        return f"服务返回 HTTP {error.response.status_code}，请检查地址、模型和认证信息。"
    if isinstance(error, httpx.ConnectError):
        return "无法连接服务，请确认服务已启动且 API 地址可访问。"
    if isinstance(error, httpx.TimeoutException):
        return "连接测试超时，请检查网络或服务状态。"
    return "接口响应格式无效，请确认它兼容所选 API 类型。"


def _extract_responses_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    parts: list[str] = []
    for output in payload.get("output", []):
        if not isinstance(output, dict):
            continue
        for item in output.get("content", []):
            if isinstance(item, dict) and item.get("type") == "output_text":
                parts.append(str(item.get("text", "")))
    return "\n".join(parts)


def _strip_markdown_fence(content: str) -> str:
    if content.startswith("```markdown") and content.endswith("```"):
        return content[len("```markdown") : -3].strip()
    if content.startswith("```") and content.endswith("```"):
        return content[3:-3].strip()
    return content
