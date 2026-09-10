import "../../packages/design-system/components.css";
import { companionId } from "../../src/mobile/shell";
import * as member from "../../src/team-member";
import { simulatedSocket } from "../../src/team-mock";
import type { Share } from "../../relay/src/protocol";

const long = "gh pr view 51 --json url,state,mergeable,headRefOid,statusCheckRollup && ".repeat(20);
const sample = [
  { type: "user", message: { role: "user", content: "https://example.com/" + "workspace/".repeat(80) } },
  { type: "assistant", message: { id: "answer", role: "assistant", content: [
    { type: "tool_use", id: "tool", name: "Bash", input: { command: long } },
    { type: "text", text: `Mensagem comprida ${long}\n\n\`\`\`sh\n${long}\n\`\`\`\n\n| Arquivo | Resultado |\n| --- | --- |\n| ${"code".repeat(150)} | Concluído |` },
  ] } },
].map(line => JSON.stringify(line)).join("\n") + "\n";
const share: Share = {
  id: "workspace1", title: "Implementar sugestão da issue", repo_name: "prometeu", branch: "main", stage: "", issue: null,
  active: "mt1", tabs: [{ id: "mt1", title: "Conversa", status: "pronta", note: null, tokens: null }], sizes: {}, audience: null,
};
localStorage.setItem("mock:team", JSON.stringify({ team: "organization1", cloud: { origin: "https://cloud.test" } }));
let failSend = false;
let online = true;
let socket: ReturnType<typeof simulatedSocket>;
member.useTransport({
  needsRelay: false,
  create: async () => { throw new Error("unused"); }, enroll: async () => { throw new Error("unused"); },
  socket: () => {
    socket = simulatedSocket(`ws://mock?m=${companionId(localStorage)}&n=Alice`, sample, share, () => online);
    const send = socket.send;
    socket.send = data => {
      if (failSend && typeof data === "string" && data.startsWith('{"t":"write"')) {
        failSend = false;
        throw new Error("test send failed");
      }
      send(data);
    };
    return socket;
  },
});
Object.assign(window, { mobileTest: {
  failSend: () => { failSend = true; },
  offline: () => { online = false; socket.presence(); },
} });
await import("../../src/mobile/main");
