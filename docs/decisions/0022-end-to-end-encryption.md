# ADR 0022 — criptografia ponta a ponta na colaboração

Data: 2026-09-07
Status: Aceito; implementação local, publicação separada.
Amplia o [ADR 0021](0021-cloud-organizations.md) e substitui a fronteira de
conteúdo legível do [relay v3](../contracts/relay-v3.md).

## Contexto

TLS termina no relay. O protocolo v3 expunha conversa, falas remotas,
comentários, citações, prévias da inbox e títulos ao operador. A escolha de
produto é configuração automática: confiar no diretório do servidor no
primeiro contato (trust on first use, TOFU), sem comparar códigos obrigatoriamente.

## Decisão

O [protocolo v4](../contracts/relay-v4.md) cifra conteúdo no dispositivo para
cada destinatário da audiência, com HPKE Auth do
[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html): P-256, HKDF-SHA256 e
AES-256-GCM. Usamos `@hpke/core`, fixado em 1.9.0, sobre WebCrypto. Não
implementamos as primitivas ou o KEM. O formato de conteúdo, TOFU, autorização,
controle de replay e persistência pertencem ao Prometeu e exigem revisão própria.

Cada escopo local gera uma identidade privada, independente de tickets e
credenciais de matrícula. O relay recebe a chave pública e uma prova de posse
ECDSA vinculada ao membro e ao desafio daquela conexão. Clientes fixam a
primeira chave de cada membro antes de enviar conteúdo. Uma chave diferente
bloqueia conteúdo com aquele membro até aceitação explícita nas configurações,
onde os códigos anterior e novo podem ser comparados por outro canal.
Não há badge de verificação manual nem transição automática assinada.

O escopo inclui origem, organização/time e matrícula; a persistência também
separa contas Cloud locais. Renovar ticket, reconectar ou reiniciar não apaga
vínculos. Existe uma identidade ativa por matrícula: um segundo Mac com outra
chave segue o fluxo de substituição, sem recuperar automaticamente a chave
privada ou os comentários antigos. Não há sincronização de dispositivos.

O dono continua sendo autoridade sobre seu processo e a audiência local.
`watch` não concede acesso. Anúncios autenticados de audiência têm revisões
persistidas; o relay não pode substituir o dono ou restaurar uma revisão já
superada no cliente. Falas remotas têm prazo de dois minutos e recibo persistido
antes da execução, inclusive após reinício. Após descriptografar, permanece a
validação de `chat_control_remote` contra pedidos abertos no Mac do dono.

## Alternativas e custos

Criptografar no relay ou usar o segredo de matrícula não protege contra o
operador. MLS foi considerado para ratchet de grupos, mas introduz estado de
grupo, distribuição de commits e recuperação offline que o transporte atual
não possui. HPKE Auth permite envelopes independentes para comentários
persistidos e reconexões sem estado compartilhado entre remetentes.

O custo é uma cópia cifrada por destinatário, até 64 membros, e ausência de
forward secrecy e recuperação automática após comprometimento. Roubar uma
chave privada de destinatário permite abrir ciphertext antigo gravado para
essa chave. Esta implementação não equivale ao Signal Protocol/WhatsApp.
Adicionar ratchet exige outra versão do contrato, migração e revisão de segurança;
não basta trocar a cifra.

## Limites de segurança

- Um servidor malicioso no primeiro contato pode substituir chaves. TOFU
  detecta mudanças posteriores, não prova honestidade inicial. Comparação
  externa de códigos é opcional. Não há key transparency.
- O relay conhece organização, membros, nomes, IDs de workspace/aba,
  destinatários, menções, presença, horários, tamanhos e dimensões de terminal.
  Pode omitir, atrasar ou reordenar mensagens e negar serviço. A cifra não
  autentica nomes de exibição, entrega, completude do histórico ou horários.
- O dono interrompe conteúdo novo para uma pessoa removida conforme sua
  audiência local. Comentários enviados por colegas usam o último anúncio
  autenticado que receberam. Um relay que omite a mudança pode atrasar sua
  aplicação nesses colegas; não há garantia de revogação instantânea global.
- Abrir uma sessão compartilhada envia o snapshot completo que o Mac conserva,
  conforme o consentimento existente de compartilhar a conversa. Comentários
  persistidos só abrem com uma caixa destinada àquela identidade. Participantes
  novos não ganham automaticamente caixas para comentários antigos.
- Conteúdo já recebido não pode ser revogado. Autores fora da audiência atual,
  chaves substituídas ou histórico sem caixa legível são omitidos da leitura.
- E2EE não protege um Mac/webview comprometido, backups de chaves privadas ou
  conteúdo enviado aos providers. Transcripts locais mantêm seu formato.
  Dados enviados em v3 não se tornam retroativamente privados.
- Testes locais não constituem auditoria criptográfica independente.

## Compatibilidade e publicação

O cliente exige v4 e `e2ee: 1`; não há fallback para texto. Credenciais e
matrículas legadas continuam válidas. O Worker passa a ler/gravar colaboração
somente sob `v4:`. Linhas v3 permanecem intactas, mas não aparecem no cliente
v4. Não existe conversão automática ou visualizador de comentários v3.

Publicar relay v4 antes de distribuir desktop v4. Trabalho local continua se
a negociação falhar. Rollback deve preservar ambos os namespaces e o arquivo
privado de segurança. Restaurar um relay/desktop v3 volta às garantias de
texto do v3 e não pode ser anunciado como rollback que conserva E2EE.
Não publicar releases nem migrar produção durante a validação local.

## Evidência

- `src/team-crypto.test.ts`: cifra real, autenticação, contexto, adulteração e
  validação de chaves; `src/team-security.test.ts`: TOFU, persistência e falhas.
- `src/team-channel.test.ts`: dois clientes, snapshot/live, fala, comentários,
  inbox, replay, audiência e rejeição de downgrade.
- `src/team.test.ts` e `src/team-organizations.test.ts`: transporte do app,
  criptografia, escopos e reconexão; `relay/src/worker.integration.test.ts`:
  Worker local, ciphertext, identidade, audiência e persistência.
- `src-tauri/src/team.rs`: arquivo privado, gravação atômica e corrupção;
  `e2e/critical-flows.spec.ts`: comentários com pares cifrados em Chromium/WebKit.
- A [matriz de providers](../quality/provider-matrix.md) declara a mesma
  proteção para Claude e Codex. Publicação e auditoria externa não fazem parte
  dessas evidências.
