/// Controle remoto aceito do colega antes de chegar ao processo do agente.
/// Texto comum não é controle; formatos de controle inválidos são reconhecidos
/// e descartados para nunca virarem prompt acidentalmente.

export type RemoteControl = { recognized: boolean; frame: unknown | null };

export function remoteControl(data: string): RemoteControl {
  if (!data.startsWith("{")) return { recognized: false, frame: null };
  try {
    const value = JSON.parse(data);
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      return { recognized: false, frame: null };
    }
    if (value.v === 1) {
      if (value.type === "turn.interrupt") return { recognized: true, frame: value };
      if (value.type === "request.respond") {
        const response = value.response;
        const answers = response?.answers;
        const ok =
          typeof value.requestId === "string" &&
          value.requestId.length > 0 &&
          value.requestId.length <= 128 &&
          (response?.outcome === "allow" ||
            (response?.outcome === "deny" && typeof response.message === "string") ||
            (response?.outcome === "answer" &&
              answers &&
              typeof answers === "object" &&
              Object.values(answers).every((answer) => typeof answer === "string"))) &&
          data.length <= 64 * 1024;
        return { recognized: true, frame: ok ? value : null };
      }
      return { recognized: true, frame: null };
    }
    // Leitor de rollback para clientes ainda na versão anterior.
    if (value.type === "control_request") {
      const ok = typeof value.request_id === "string" && value.request_id.length <= 128 && value.request?.subtype === "interrupt";
      return { recognized: true, frame: ok ? value : null };
    }
    if (value.type === "control_response") {
      const response = value.response;
      const answer = response?.response;
      const ok =
        response?.subtype === "success" &&
        typeof response.request_id === "string" &&
        response.request_id.length <= 128 &&
        (answer?.behavior === "allow" || answer?.behavior === "deny") &&
        data.length <= 64 * 1024;
      return { recognized: true, frame: ok ? value : null };
    }
    return { recognized: value.type.startsWith("control_"), frame: null };
  } catch {
    return { recognized: false, frame: null };
  }
}
