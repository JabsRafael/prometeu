# ADR 0021 — Organizações e convites no Cloud

Data: 2026-09-07
Status: Aceito; protocolo e fronteira de conteúdo ampliados pelo
[ADR 0022](0022-end-to-end-encryption.md).
A reconexão obrigatória ao vencer cada lease foi substituída pela renovação
do [ADR 0034](0034-mobile-pairing-continuity.md).
Amplia [ADR 0015](0015-cloud-rails.md) e substitui a limitação de propriedade
exclusivamente pessoal do [ADR 0020](0020-personal-catalog-and-local-items.md).

## Contexto

Criação e matrícula de times existiam no desktop, por segredo compartilhado.
O Cloud possuía somente uma prévia estática de organização. O produto precisa
administrar organizações no navegador, exigir aceitação de convite por email
e compartilhar tanto workspaces ao vivo quanto catálogos de ferramentas.

## Decisão

A organização no Rails passa a ser autoridade sobre identidade, matrículas,
papéis e catálogos. Não introduzimos uma segunda camada de times. Usamos Active
Record, constraints SQLite, tokens assinados e Action Mailer existentes.
Catálogos reutilizam documento revisionado e validação de portabilidade;
compartilhamento entre catálogos é cópia explícita e independente.

Preservamos o relay e o protocolo de conversas. Tickets individuais de uso
único autenticam leases de 60 segundos, com consulta ao Cloud no handshake.
Isso dispensa novos segredos de serviço, assinatura JWT customizada e webhook
de revogação, ao custo de renovar conexões e snapshots periodicamente. O tráfego
para após o prazo mesmo quando o alarme do Durable Object atrasa.

Consentimento de envio de workspace inclui organização e matrícula. Troca de
contexto não envia trabalho antigo a outro grupo. Times legados mantêm seu
namespace e credenciais durante a transição; selecionar organização conserva
backup local. Identidades anônimas não são convertidas em emails inferidos.

## Consequências

O desktop continua útil sem conta. Colaboração institucional exige Cloud
disponível para renovar autorização. Revogação tem limite de 60 segundos.
Organizações suportam os mesmos 64 membros do relay. Catálogos pessoais seguem
sincronizados como antes; copiar da organização é uma adoção explícita, sem
assinatura automática das próximas edições. Código recebido nunca é ativado
somente por aceitar convite.

Rollback mantém o schema expandido e o storage legado. Publicação segue Cloud,
relay, desktop; não há contração destrutiva implícita. Contratos, configuração,
limites e evidência estão em [cloud-organizations.md](../contracts/cloud-organizations.md).
