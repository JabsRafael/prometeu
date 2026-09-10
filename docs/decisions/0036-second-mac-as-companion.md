# ADR 0036 — segundo Mac como dispositivo companheiro

Data: 2026-09-11
Status: Aceito. Amplia o [ADR 0027](0027-companion-devices.md) e precisa a
regra de "uma identidade ativa por matrícula" do
[ADR 0022](0022-end-to-end-encryption.md), sem alterar o
[relay v4](../contracts/relay-v4.md).

## Contexto

Dois Macs com a mesma conta recebem a mesma matrícula e, portanto, o mesmo ID
de membro no relay. Cada Mac gera a própria identidade privada. O relay guarda
uma chave por membro: o último Mac a conectar substitui a chave do outro. O
Mac substituído vê a própria chave trocada no diretório, nunca conclui o
handshake e falha ao compartilhar com "Falha no compartilhamento criptografado".
Os dois Macs reconectam com backoff e se substituem em ciclo; o celular vê a
chave da pessoa mudar e bloqueia o conteúdo.

## Opções consideradas

1. **Sincronizar a chave privada entre Macs.** Exige transporte da chave via
   Cloud ou pareamento; o Cloud passaria a tocar material de chave.
2. **Todo Mac vira dispositivo (v5).** Migra a identidade do primeiro Mac,
   invalida vínculos TOFU e torna comentários antigos ilegíveis.
3. **Somente o primeiro Mac mantém a matrícula; os demais entram como
   companheiros.** Reusa o modelo do ADR 0027 sem migração.

## Decisão

Opção 3. Cada Mac gera um ID de dispositivo (`device.json`, separado do login
para sobreviver ao logout) com um rótulo vindo do nome do computador. O Rust
envia esse ID em `GET /api/organizations?device=` e em
`POST /api/organizations/:id/relay-ticket { device, label }`.

A matrícula ganha `desktop_id`: o primeiro dispositivo que consulta ou pede
ticket reivindica a matrícula e continua sendo `member` igual ao ID da
matrícula, exatamente como antes. Qualquer outro Mac da mesma pessoa recebe
`member` igual ao próprio ID de dispositivo, registrado como `Companion` com o
rótulo do Mac, e o roster o lista com `person` igual à matrícula. Tickets de
companheiro passam a aceitar sessão desktop além de sessão de navegador.
Desktops antigos que não enviam `device` seguem identificando a matrícula.

No cliente, um companheiro pode ser dono de shares. Audiência, menções e
admissão de `watch` e `write` resolvem cada membro para a pessoa a que
pertence, seja ele matrícula ou companheiro. Os dispositivos da mesma pessoa
que o dono, incluindo o primeiro Mac, só recebem o share pelo controle remoto
(ADR 0030). O seletor de audiência omite a própria pessoa do dono.

## Consequências

- Nenhuma migração de identidade para quem usa um Mac só. Vínculos, comentários
  e audiências continuam válidos.
- O primeiro Mac de cada organização fica fixo em `desktop_id`. Se ele deixar
  de existir, os outros Macs seguem funcionando como companheiros; liberar a
  matrícula para outro Mac ainda exige intervenção no Cloud e passa pelo fluxo
  de troca de chave nos colegas.
- Ao atualizar Macs que já colidiam, o primeiro a consultar o Cloud fica com a
  matrícula; o outro recebe identidade nova como companheiro e o celular pode
  ver uma troca de chave uma vez.
- Um Mac companheiro conta nas cinco vagas de companheiros da pessoa e no
  roster de 64 do relay.

## Evidência

- `src/team-channel.test.ts`: companheiro dono de share alcança o time sem os
  próprios dispositivos e, com controle remoto, o primeiro Mac e o celular.
- `prometeu-cloud/test/integration/organizations_test.rb`: primeiro Mac
  mantém a matrícula, segundo Mac vira companheiro com rótulo, desktop sem
  `device` continua igual, ID inválido é rejeitado.
