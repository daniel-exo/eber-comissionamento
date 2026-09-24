# Comissionamento EBER

App para registrar o comissionamento pré-partida da planta de etanol de milho da EBER Bioenergia (Montes Claros de Goiás/GO): áreas → equipamentos centrais → matriz por especialidade (Mecânica, Elétrica, Instrumentação, Operação) → checklist por equipamento. Funciona no celular, no tablet e no computador, inclusive sem sinal.

- **Site:** GitHub Pages (este repositório).
- **Login e banco:** Firebase Authentication (e-mail e senha) + Cloud Firestore, no plano gratuito (Spark). Sem cartão cadastrado, não há cobrança: se um limite diário fosse atingido, o banco só pararia até o dia seguinte.

## Primeira instalação

### 1. Firebase (uma vez)

1. Em <https://console.firebase.google.com>, clique em **Criar projeto**. Nome sugerido: `eber-comissionamento`. O Google Analytics pode ficar desligado.
2. **Authentication → Começar → Método de login → E-mail/senha → Ativar → Salvar.**
3. **Firestore Database → Criar banco de dados.** Local: `southamerica-east1 (São Paulo)`. Modo: **produção**.
4. Ainda no Firestore, aba **Regras**: apague o conteúdo, cole o arquivo `firestore.rules` deste repositório e clique em **Publicar**.
5. **Configurações do projeto (engrenagem) → Seus apps → ícone `</>` (Web).** Apelido: `Comissionamento`. Não marque o Firebase Hosting. Ao final aparece um bloco `const firebaseConfig = { ... }`: copie os valores para o arquivo `js/firebase-config.js`, no lugar de `COLE_AQUI...`. Esses valores não são segredo; quem protege os dados são o login e as regras.

### 2. GitHub (uma vez)

1. Crie um repositório **público** chamado `eber-comissionamento`.
2. **Add file → Upload files**: arraste todo o conteúdo desta pasta (inclusive as pastas `js`, `dados`, `icones`, `ferramentas` e o arquivo `.nojekyll`) e clique em **Commit changes**.
3. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, pasta `/ (root)` → **Save**. Em um ou dois minutos o app fica em `https://SEU-USUARIO.github.io/eber-comissionamento/`.
4. De volta ao Firebase: **Authentication → Configurações → Domínios autorizados → Adicionar domínio** → `SEU-USUARIO.github.io`.

### 3. Cadastrar usuários (a cada pessoa nova)

O acesso tem duas chaves: a conta de login e a liberação no banco. Sem a liberação, a pessoa entra mas não vê nem grava nada.

1. **Authentication → Usuários → Adicionar usuário**: e-mail da pessoa e uma senha provisória. Copie o **UID** que aparece na lista.
2. **Firestore Database → Dados → Iniciar coleção** (na primeira vez) com o ID `usuarios`. Crie um documento cujo **ID do documento** é o UID copiado, com um campo `nome` (string) com o nome da pessoa.
3. Passe o endereço do app, o e-mail e a senha provisória. A pessoa pode criar a própria senha em **Esqueci a senha** na tela de entrada.

Se alguém entrar antes de ser liberado, o app mostra o UID dessa pessoa com um botão para copiar; basta criar o documento do passo 2.

Para **remover** alguém: apague o documento dela em `usuarios` e desative a conta em Authentication.

### 4. No celular

1. Abra o endereço no Chrome (Android) ou no Safari (iPhone) **com internet** e entre com o login.
2. Instale como aplicativo: no Android, menu ⋮ → **Instalar app** (ou *Adicionar à tela inicial*); no iPhone, **Compartilhar → Adicionar à Tela de Início**.
3. Ainda com internet, abra cada área que vai usar em campo. A partir daí o app abre e grava sem sinal.

## Como funciona sem sinal

- Cada marcação é gravada primeiro no aparelho e entra numa fila. O botão no canto superior direito mostra a situação: *Sincronizado*, *Enviando N…* ou *Offline · N a enviar*.
- Quando o sinal volta, a fila é enviada sozinha, na ordem em que as marcações foram feitas.
- Duas pessoas podem marcar itens diferentes do mesmo checklist, até ao mesmo tempo e sem sinal: uma não apaga a marcação da outra. Se as duas mexerem **no mesmo item**, vale a última que chegar ao banco.
- Não saia da conta com marcações ainda não enviadas: o app avisa antes.

## Estrutura do banco

Coleção `centrais`, **um documento por equipamento central**. O ID é a área + o tag central, por exemplo `200.TNQ-2001` ou `200.A` para o grupo A. Dentro dele, o mapa `ck` guarda todos os checklists dos equipamentos daquele central:

```
centrais/200.TNQ-2001
{
  area:    "200",
  central: "TNQ-2001",
  por:     "fulano@empresa.com",          // última alteração no documento
  em:      <data e hora do servidor>,
  ck: {
    "200:TNQ-2001~OPE":          { checked: { "OPE-COM-01": true, ... }, por: "...", em: ... },
    "200:TNQ-2001:AGT-2001~MEC": { checked: { "MEC-AGT-01": true, "MEC-AGT-02": false }, por: "...", em: ... },
    ...
  }
}
```

- A chave de cada checklist é o local do equipamento na lista (com `:` no lugar de `.`) + `~` + especialidade.
- Por que um documento por central, e não por checklist: cada abertura de área lê todos os documentos dela. Assim, abrir a área 400 lê 41 documentos em vez de até 1.770, e o uso fica folgado dentro da cota gratuita (50 mil leituras por dia), mesmo no fim da obra e com 10 pessoas.
- O documento só passa a existir quando alguém marca o primeiro item daquele central. Checklist sem entrada = não iniciado. Item desmarcado fica gravado como `false`.
- O status (não iniciado / em andamento / aprovado) não é gravado: o app calcula comparando `checked` com a lista de itens.
- Coleção `usuarios`: um documento por pessoa liberada (ID = UID do login).

## Dados de referência (pasta `dados/`)

Gerados a partir da **Lista de Equipamentos Consolidada** e do **Book de Comissionamento**:

```
python ferramentas/gerar_dados.py EBER_Lista_de_Equipamentos_Consolidado.xlsx ferramentas/checklists.json
```

`ferramentas/checklists.json` é produzido pelo gerador do book (`node build.js`); a cópia atual já está no repositório. Depois de gerar, suba para o GitHub a pasta `dados/` e o arquivo `ferramentas/registro-ids.json`.

**IDs estáveis.** O arquivo `ferramentas/registro-ids.json` fixa o código de cada tarefa (ex.: `MEC-AGT-03`). Uma tarefa já registrada nunca muda de código, mesmo que a ordem mude no book; uma tarefa nova ganha o próximo número livre. Isso garante que as marcações gravadas nunca "pulem" para outro item. Se uma tarefa tiver só o texto corrigido, edite o registro trocando o texto antigo pelo novo, para ela manter o código.

**Operação.** As 7 tarefas comuns (`OPE-COM-01` a `07`) entram apenas nos tags que são **equipamento central** na lista (coluna "TAG DO EQUIPAMENTO CENTRAL", fora dos grupos A/B). As tarefas específicas de cada tipo valem para todos os tags do tipo. O Book de Comissionamento segue a mesma regra e usa os mesmos códigos: ele lê este registro de IDs ao ser gerado.

## Atualizações do app

O app se atualiza sozinho: ao abrir, usa a versão guardada e baixa a nova em segundo plano, que passa a valer na abertura seguinte. Ao publicar uma mudança grande, aumente o número em `eber-comiss-v2` no `sw.js` (v3, v4…) para renovar o que fica guardado nos aparelhos.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html`, `app.css` | Estrutura e visual |
| `js/app.js` | Telas e regras de status |
| `js/store.js` | Única parte que fala com o Firebase (login e banco) |
| `js/firebase-config.js` | Configuração do projeto Firebase |
| `js/vendor/firebase.js` | SDK do Firebase 12.19.0 empacotado (para funcionar offline) |
| `sw.js`, `manifest.webmanifest` | Instalação como aplicativo e funcionamento offline |
| `firestore.rules` | Regras de segurança do banco |
| `dados/` | Áreas, equipamentos e checklists (gerados) |
| `ferramentas/` | Gerador dos dados e registro de IDs |

## Desenvolvimento local

Com o [Firebase CLI](https://firebase.google.com/docs/cli) instalado, rode `firebase emulators:start --only auth,firestore` e sirva a pasta em `http://localhost:8000` (ex.: `python -m http.server 8000`). Em `localhost` o app se conecta sozinho aos emuladores em vez do projeto real.
