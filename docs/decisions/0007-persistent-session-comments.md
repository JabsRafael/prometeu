# ADR 0007 — Comentários persistentes ao lado da sessão

Data: 2026-09-04
Status: Aceito

## Contexto

Notas de colaboração eram inseridas no transcript no instante em que chegavam.
Com a sessão em andamento, elas saíam da área visível e perdiam a função de
acompanhar uma decisão até sua conclusão. Para criar uma nota, a pessoa também
precisava trocar a caixa principal do modo do agente para o modo de nota. Essa
troca escondia o destino da próxima mensagem no momento mais sensível da
interação.

A necessidade não é adicionar outra mensagem ao chat. É manter uma conversa
humana sobre um trecho do trabalho, tornar pendências encontráveis e declarar
quando deixaram de exigir atenção.

## Opções consideradas

1. Manter notas no transcript e melhorar seus marcadores visuais.
2. Representar comentários como mensagens comuns enviadas ao agente.
3. Manter threads persistentes num painel lateral, ancoradas à conversa e com
   estado explícito.

## Decisão

Comentários ficam num painel lateral próprio. A caixa principal sempre envia
mensagens ao agente.

Cada thread possui uma raiz, zero ou mais respostas e estado aberto ou
resolvido. Ela pode ser geral da aba ou guardar `tab` e `Piece.key` como âncora
de um trecho. A citação é contexto legível, não identidade. Marcadores no
transcript abrem a thread e a thread pode levar de volta ao trecho.

Menções criam atribuições em **Para mim**. Abrir uma atribuição não significa
concluir trabalho; somente resolver a raiz remove a thread da inbox de todos.
Qualquer colaborador que ainda tenha acesso ao workspace pode resolver.

O protocolo relay v3 recebe campos opcionais e os frames aditivos
`note_reply` e `note_resolve`. O `welcome` anuncia `comments: 1`; sem essa
capability, o app mantém comentários simples e oculta resposta e resolução.
Nesse fallback, abrir ainda conclui uma entrada da inbox. Não há migração
destrutiva: notas anteriores viram raízes gerais abertas.

## Consequências

Positivas:

- pendências continuam visíveis enquanto a sessão cresce;
- escrever para o time não muda silenciosamente o destino da caixa do agente;
- respostas preservam o contexto e a resolução encerra a pendência para todos;
- dados e clientes v3 anteriores continuam legíveis.

Negativas:

- o relay passa a persistir estado e respostas de threads;
- uma âncora pode ficar indisponível após retenção ou mudança de transcript; a
  citação continua visível nesse caso;
- clientes antigos podem mostrar respostas como notas independentes;
- resolução não tem papéis adicionais: acesso ao workspace é a autoridade.

## Evidência

- `src/notes.test.ts` cobre agrupamento, aba, legado e ordem por atividade;
- `src/team.test.ts` cobre capability, criação, resposta, resolução e inbox;
- `relay/src/protocol.test.ts` e `relay/src/logic.test.ts` cobrem validação,
  persistência, audiência, atribuição e compatibilidade;
- `e2e/critical-flows.spec.ts` cobre criação contextual, resposta, resolução e
  permanência da caixa principal no agente;
- `docs/prototypes/multiplayer-comments.html` registra a proposta visual.
