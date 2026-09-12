// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { askRepository } from "../api";
import type { RepositoryAnswer } from "../types";
import { useRepositoryQa } from "./useRepositoryQa";

vi.mock("../api", () => ({ askRepository: vi.fn() }));
const answer = (text = "引用 [1]", status: RepositoryAnswer["grounding_status"] = "grounded"): RepositoryAnswer => ({
  question: "如何启动？", answer: text, provider: "ollama", engine_name: "test",
  citations: [], evidence_count: 1, reference_count: 1, confidence: "high", grounding_status: status, elapsed_ms: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  return renderHook(({ revision, active, ready }) => useRepositoryQa(1, revision, active, "ollama", ready), {
    initialProps: { revision: 0, active: true, ready: true },
  });
}
beforeEach(() => { vi.mocked(askRepository).mockReset(); });
afterEach(cleanup);

it("locks before rerender so repeated submission calls the model only once", async () => {
  const request = deferred<RepositoryAnswer>();
  vi.mocked(askRepository).mockReturnValue(request.promise);
  const view = setup();
  act(() => view.result.current.setQuestion("如何启动？"));
  act(() => { void view.result.current.submit(); void view.result.current.submit(); });
  expect(askRepository).toHaveBeenCalledTimes(1);
  expect(view.result.current.loading).toBe(true);
  await act(async () => request.resolve(answer()));
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.messages).toHaveLength(2);
});

it.each(["resolve", "reject"] as const)("ignores a late %s after unmount without retrying", async (mode) => {
  const request = deferred<RepositoryAnswer>();
  vi.mocked(askRepository).mockReturnValue(request.promise);
  const view = setup();
  act(() => view.result.current.setQuestion("如何启动？"));
  act(() => { void view.result.current.submit(); });
  const signal = vi.mocked(askRepository).mock.calls[0][4];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { if (mode === "resolve") request.resolve(answer()); else request.reject(new Error("late")); });
  expect(askRepository).toHaveBeenCalledTimes(1);
});

it("does not include a failed citation validation answer in follow-up context", async () => {
  vi.mocked(askRepository).mockResolvedValue(answer("证据不可校验", "reference_failed"));
  const view = setup();
  act(() => view.result.current.setQuestion("如何启动？"));
  await act(async () => view.result.current.submit());
  act(() => view.result.current.setQuestion("相关测试在哪里？"));
  await act(async () => view.result.current.submit());
  expect(vi.mocked(askRepository).mock.calls[1][3]).toEqual([]);
});

it("retries a failed old-version turn with empty context and no automatic request", async () => {
  vi.mocked(askRepository).mockResolvedValueOnce(answer()).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(answer("新版本答案"));
  const view = setup();
  act(() => view.result.current.setQuestion("如何启动？"));
  await act(async () => view.result.current.submit());
  act(() => view.result.current.setQuestion("它的测试？"));
  await act(async () => view.result.current.submit());
  const id = view.result.current.messages.find((message) => message.retryId !== undefined)!.retryId!;
  view.rerender({ revision: 1, active: true, ready: true });
  expect(askRepository).toHaveBeenCalledTimes(2);
  expect(view.result.current.messages.some((message) => message.content === "引用 [1]")).toBe(true);
  await act(async () => view.result.current.retry(id));
  expect(vi.mocked(askRepository).mock.calls[2][3]).toEqual([]);
  expect(view.result.current.messages.filter((message) => message.role === "user")).toHaveLength(2);
});

it.each(["a", "x".repeat(2001)])("rejects out-of-range questions before any model request", async (text) => {
  const view = setup();
  act(() => view.result.current.setQuestion(text));
  await act(async () => view.result.current.submit());
  expect(askRepository).not.toHaveBeenCalled();
  expect(view.result.current.messages.at(-1)?.content).toBe("请输入 2–2000 个字符的问题。");
  expect(view.result.current.loading).toBe(false);
});

it("never requests while hidden or missing a model, and only clears on explicit /clear", async () => {
  vi.mocked(askRepository).mockResolvedValue(answer());
  const view = setup();
  act(() => view.result.current.setQuestion("如何启动？"));
  await act(async () => view.result.current.submit());
  view.rerender({ revision: 0, active: false, ready: true });
  act(() => view.result.current.setQuestion("第二个问题"));
  await act(async () => view.result.current.submit());
  view.rerender({ revision: 0, active: true, ready: false });
  await act(async () => view.result.current.submit());
  expect(askRepository).toHaveBeenCalledTimes(1);
  expect(view.result.current.messages).toHaveLength(2);
  act(() => view.result.current.setQuestion("/clear"));
  await act(async () => view.result.current.submit());
  expect(view.result.current.messages).toEqual([]);
  expect(askRepository).toHaveBeenCalledTimes(1);
});

it("keeps transcript identity stable while editing the next draft", async () => {
  vi.mocked(askRepository).mockResolvedValue(answer());
  const view = setup();
  act(() => view.result.current.setQuestion("如何启动？"));
  await act(async () => view.result.current.submit());
  const messages = view.result.current.messages;
  act(() => view.result.current.setQuestion("新的草稿"));
  expect(view.result.current.messages).toBe(messages);
});
