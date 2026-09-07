# ADR 0020 — Catálogo no SaaS e compartilhamento explícito no desktop

Data: 2026-09-07
Status: Aceito
Substitui: [ADR 0019](0019-cloud-catalog.md)

## Contexto

O catálogo anterior tinha persistência no SaaS, mas a autoria permanecia
exclusivamente no desktop. Conectar uma conta publicava os hubs locais;
MCPs e plugins portáteis não podiam continuar privados por escolha.

A necessidade é cadastrar MCPs, plugins e skills no navegador, recebê-los
nos desktops e combinar esse conjunto com definições locais opcionais.
Catálogos de times, projetos e organizações são evolução futura.

## Opções consideradas

1. Apenas acrescentar formulários ao documento anterior. Não oferece privacidade local.
2. Criar imediatamente organizações, times, permissões e sincronização offline com merge.
3. Manter a conta como proprietária do catálogo, acrescentar autoria web e
   vínculos explícitos entre definições remotas e registros locais.

## Decisão

Adotar a opção 3. Criações desktop são privadas por padrão. Compartilhar é
uma ação explícita; editar uma definição vinculada publica na conta. Uma
cópia local recebe outro ID e não altera o item compartilhado.

O SaaS usa Rails convencional, formulários do Design System, cookies e CSRF.
O desktop mantém Bearer. O documento revisionado existente continua sendo a
unidade de armazenamento; operações web alteram somente o item escolhido,
preservando as outras coleções. Conflitos são visíveis e conservam rascunhos.
Nenhuma edição obsoleta é reenviada automaticamente sobre uma revisão nova.

Skills são definições de texto, materializadas como pacotes para reutilizar
os adapters e seletores de plugins existentes. Código de plugins continua
vindo de origem remota por instalação explícita; não há upload de diretórios.

Receber definições não ativa ferramentas nas conversas. Exclusão remota não
apaga arquivos ou credenciais dos Macs. Nomes privados são preservados por
um mapa de vínculos que separa o ID da conta do ID no hub local.

## Consequências

- Gerenciamento no navegador e escolha local funcionam sem novo serviço,
  dependência ou migração de banco.
- O JSON inteiro e seu limite de 256 KB permanecem. Edições concorrentes em
  itens diferentes também podem exigir nova tentativa explícita.
- Clientes antigos preservam skills novas ao omitir a coleção; seu comportamento
  antigo de publicação automática só muda quando o desktop é atualizado.
- Uma cópia de plugin compartilha os arquivos do clone, mas não sua definição
  online. Skills copiadas têm conteúdo materializado independente.
- Ações legadas continuam sincronizadas como antes e não recebem editor web nesta etapa.
- Futuras permissões e catálogos institucionais exigem identidade composta
  pelo proprietário, catálogo e item. Esta etapa não simula esses escopos.
- Rollback restaura código anterior mantendo JSON e arquivos locais. Desktop
  antigo ignora skills; não usar rollback como modo de remover dados novos.

## Evidência

O [contrato do catálogo](../contracts/cloud-catalog.md) descreve formatos,
compatibilidade, comportamento observável e testes dos dois repositórios.
