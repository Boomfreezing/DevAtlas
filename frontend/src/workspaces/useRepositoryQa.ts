import { useEffect, useMemo, useRef, useState } from "react";
import { askRepository } from "../api";
import type { RepositoryAnswer, RepositoryConversationItem } from "../types";

interface QaTurn {
  id: number;
  revision: number;
  question: string;
  history: RepositoryConversationItem[];
  response?: RepositoryAnswer;
  error?: string;
}

export interface QaTerminalMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  response?: RepositoryAnswer;
  retryId?: number;
}

/** Only complete turns from the current index may become follow-up context. */
function completedHistory(turns: QaTurn[], revision: number): RepositoryConversationItem[] {
  return turns.filter((turn) => turn.revision === revision && turn.response &&
    turn.response.grounding_status !== "reference_failed")
    .slice(-5).flatMap((turn) => [
      { role: "user" as const, content: turn.question },
      { role: "assistant" as const, content: turn.response!.answer.slice(0, 4000) },
    ]);
}

/** Closing the panel stops waiting, not necessarily the provider's generation. Never auto-retry. */
export function useRepositoryQa(projectId: number, revision: number, active: boolean, provider: string, modelReady: boolean) {
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const turnsRef = useRef(turns);
  const nextId = useRef(0);
  const requestRef = useRef<{ id: number; key: string; controller: AbortController } | null>(null);
  const key = `${projectId}:${revision}`;
  const contextRef = useRef({ key, active });
  contextRef.current = { key, active };

  function publish(next: QaTurn[]) {
    turnsRef.current = next;
    setTurns(next);
  }

  useEffect(() => {
    const pending = requestRef.current;
    if (!pending || (active && pending.key === key)) return;
    requestRef.current = null;
    pending.controller.abort();
    const message = pending.key !== key
      ? "仓库分析结果已更新，本次回答不再使用。请基于当前版本重新提问。"
      : "已停止等待本次回答；模型服务可能仍在生成。需要时可手动重试。";
    const next = turnsRef.current.map((turn) => turn.id === pending.id ? { ...turn, error: message } : turn);
    turnsRef.current = next;
    setTurns(next);
    setLoading(false);
  }, [active, key]);

  useEffect(() => () => {
    const pending = requestRef.current;
    requestRef.current = null;
    pending?.controller.abort();
  }, []);

  async function submit(value: string, retryId?: number) {
    const normalized = value.trim();
    if (!normalized || !contextRef.current.active || requestRef.current) return;
    if (normalized === "/clear") {
      publish([]);
      setQuestion("");
      return;
    }
    if (!modelReady) return;
    const original = retryId === undefined ? undefined : turnsRef.current.find((turn) => turn.id === retryId && turn.error);
    if (retryId !== undefined && !original) return;
    // Retry uses the original successful context, not messages posted after that failure.
    const history = original
      ? (original.revision === revision ? original.history : [])
      : completedHistory(turnsRef.current, revision);
    const turn: QaTurn = {
      id: original?.id ?? ++nextId.current, revision, question: normalized, history,
    };
    const replace = (nextTurn: QaTurn) => publish(original
      ? turnsRef.current.map((item) => item.id === turn.id ? nextTurn : item)
      : [...turnsRef.current, nextTurn]);
    if (normalized.length < 2 || normalized.length > 2000) {
      replace({ ...turn, error: "请输入 2–2000 个字符的问题。" });
      return;
    }
    const pending = { id: turn.id, key, controller: new AbortController() };
    requestRef.current = pending; // Synchronous lock also covers repeated submit events before a render.
    replace(turn);
    if (!original) setQuestion("");
    setLoading(true);
    const isCurrent = () => requestRef.current === pending && !pending.controller.signal.aborted &&
      contextRef.current.key === pending.key && contextRef.current.active;
    try {
      const response = await askRepository(projectId, normalized, provider, history, pending.controller.signal);
      if (!isCurrent()) return;
      publish(turnsRef.current.map((item) => item.id === turn.id ? { ...turn, response } : item));
    } catch (error) {
      if (!isCurrent()) return;
      publish(turnsRef.current.map((item) => item.id === turn.id ? {
        ...turn, error: error instanceof Error ? error.message : "智能问答请求失败",
      } : item));
    } finally {
      if (isCurrent()) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  const messages = useMemo(() => turns.flatMap((turn) => {
    const items: QaTerminalMessage[] = [{ id: `${turn.id}:user`, role: "user", content: turn.question }];
    if (turn.response) items.push({ id: `${turn.id}:answer`, role: "assistant", content: turn.response.answer, response: turn.response });
    else if (turn.error) items.push({ id: `${turn.id}:error`, role: "system", content: turn.error, retryId: turn.id });
    return items;
  }), [turns]);

  return {
    messages, question, setQuestion, loading,
    submit: () => submit(question),
    retry: (id: number) => {
      const turn = turnsRef.current.find((item) => item.id === id);
      return turn ? submit(turn.question, id) : Promise.resolve();
    },
  };
}
