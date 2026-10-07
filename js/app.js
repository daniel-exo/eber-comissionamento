// Interface do app de comissionamento: áreas → equipamentos centrais → matriz → checklist,
// e ações de inspeção por área.
// Toda a leitura/gravação passa por store.js.
import * as store from './store.js';

const VERSAO = '1.5.0';
const SECS = ['MEC', 'ELE', 'INS', 'OPE'];
const SEC = { MEC: 'Mecânica', ELE: 'Elétrica', INS: 'Instrumentação', OPE: 'Operação' };
const ONDE = { C: 'Campo', S: 'Supervisório', CS: 'Campo + Supervisório' };
const LOGOS = `<div class="logos">
  <img class="logo tema-claro" src="icones/logo.png" alt="EBER Bioenergia e Agricultura"><img class="logo tema-escuro" src="icones/eber-branco.png" alt="EBER Bioenergia e Agricultura" onerror="this.onerror=null;this.src='icones/logo.png';this.classList.add('fallback')">
</div>`;
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const tcase = s => { if (!s) return ''; const l = s.toLowerCase().replace(/[a-z0-9"\-\/]*\d[a-z0-9"\-\/]*/g, m => m.toUpperCase()); return l.charAt(0).toUpperCase() + l.slice(1); };
const pct = (x, n) => n ? Math.round(100 * x / n) : 0;
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ---------------- dados de referência (arquivos da pasta dados/) ---------------- */
let L = null, AREAS = [];
const AREA = {};            // id -> { area, nome, centrais, EQ, CEN }
async function carregarJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); }
async function carregarArea(id) {
  if (AREA[id]) return AREA[id];
  const a = await carregarJSON(`dados/area-${id}.json`);
  a.EQ = {}; a.CEN = {};
  a.centrais.forEach(c => { a.CEN[c.tag] = c; c.itens.forEach(it => { it.c = c.tag; a.EQ[it.loc] = it; }); });
  AREA[id] = a;
  return a;
}
const listaCache = {};
function listaDe(it, sec) {
  const k = L.tipos[it.cat].L[sec];
  if (!k) return null;
  const ck = k + (sec === 'OPE' && it.cen ? '+C' : '');
  if (!listaCache[ck]) {
    let arr = L.listas[k];
    if (sec === 'OPE' && it.cen) arr = L.opeCom[it.cat].map((x, i) => ({ id: 'OPE-COM-' + String(i + 1).padStart(2, '0'), t: x.t, o: x.o })).concat(arr);
    listaCache[ck] = arr;
  }
  return listaCache[ck];
}
const nomeLista = (it, sec) => L.tipos[it.cat].L[sec] + (sec === 'OPE' && it.cen ? ' + comuns' : '');

/* ---------------- estado vindo do banco ---------------- */
let user = null;
let areaAtiva = null, docs = {}, pendentes = 0, doCache = true, erroBanco = '', unsub = null;
const docId = (loc, sec) => loc + '~' + sec;
const checkedOf = id => (docs[id] && docs[id].checked) || {};

function stat(a, loc, sec) {
  const it = a.EQ[loc], list = listaDe(it, sec);
  if (!list) return null;
  const ch = checkedOf(docId(loc, sec));
  let done = 0; for (const t of list) if (ch[t.id] === true) done++;
  return { done, total: list.length, s: done === 0 ? 'none' : done === list.length ? 'ok' : 'prog' };
}
function aggregate(a, itens) {
  const r = { ok: 0, prog: 0, none: 0, n: 0, di: 0, ti: 0, bySec: {} };
  SECS.forEach(s => r.bySec[s] = { ok: 0, n: 0 });
  itens.forEach(it => SECS.forEach(s => {
    const st = stat(a, it.loc, s); if (!st) return;
    r[st.s]++; r.n++; r.di += st.done; r.ti += st.total;
    r.bySec[s].n++; if (st.s === 'ok') r.bySec[s].ok++;
  }));
  return r;
}
const allItens = a => a.centrais.flatMap(c => c.itens);

/* ---------------- ações de inspeção por área ----------------
   A lista de ações vem do arquivo dados/acoes.json, gerado a partir da planilha (ferramentas/gerar_acoes.py).
   O banco guarda só o check de cada ação, no documento centrais/<área>.ACOES, uma entrada por ação
   ("<área>:ACOES:<código>~ACO"), gravada pela mesma função dos checklists (store.marcarItem). */
let ACOES = { areas: {} }, acoesT = 0;
let filtA = { q: '', pend: false };
let baseA = null;            // situação de cada ação ao abrir a lista: mantém cada uma no lugar enquanto a pessoa marca
const acoesDe = area => (ACOES.areas && ACOES.areas[area]) || [];
const temAcoes = () => Object.values(ACOES.areas || {}).some(l => l.length);
const acLoc = (area, id) => area + '.ACOES.' + id;
const acFeita = (area, id) => checkedOf(docId(acLoc(area, id), 'ACO'))[id] === true;
function acContar(area) { const l = acoesDe(area); let ok = 0; for (const x of l) if (acFeita(area, x.id)) ok++; return { ok, n: l.length }; }
async function carregarAcoes(fresco) {
  // sem "fresco": cópia guardada no aparelho (abre na hora). Com "fresco": versão atual do servidor.
  try {
    const r = await fetch('dados/acoes.json' + (fresco ? '?fresco=' + Date.now() : ''), fresco ? { cache: 'no-store' } : undefined);
    if (!r.ok) return false;
    const j = await r.json();
    if (!j || !j.areas || typeof j.areas !== 'object') return false;
    const mudou = JSON.stringify(j.areas) !== JSON.stringify(ACOES.areas);
    ACOES = j;
    return mudou;
  } catch (e) { return false; }   // sem o arquivo, o app segue normalmente, só sem as ações
}
function atualizarAcoes(forcar) {   // busca a lista mais nova, no máximo uma vez por minuto
  if (!navigator.onLine || (!forcar && Date.now() - acoesT < 60000)) return;
  acoesT = Date.now();
  carregarAcoes(true).then(mudou => { if (mudou && user) { if (nav.v === 'acoes') capturarAcoes(); render(); } });
}
function capturarAcoes() {
  baseA = { a: nav.a, cache: doCache, tocou: false, feita: {} };
  for (const x of acoesDe(nav.a)) baseA.feita[x.id] = acFeita(nav.a, x.id);
}

function abrirArea(id) {
  if (areaAtiva === id && unsub) return;
  if (unsub) unsub();
  areaAtiva = id; docs = {}; pendentes = 0; doCache = true; erroBanco = '';
  unsub = store.observarArea(id, (d, meta) => {
    docs = d; pendentes = meta.pendentes; doCache = meta.doCache; erroBanco = '';
    const a = AREA[id];
    if (a) { const g = aggregate(a, allItens(a)); lsSet('resumo-' + id, { ok: g.ok, prog: g.prog, n: g.n, di: g.di, ti: g.ti, t: Date.now(), ac: acContar(id) }); }
    refresh(); syncUI();
  }, e => {
    erroBanco = e && e.code || 'erro';
    unsub = null; syncUI();
    if (erroBanco === 'permission-denied') render();
  });
}

/* ---------------- sincronização: chip + painel ---------------- */
const $sync = document.getElementById('sync'), $scrim = document.getElementById('scrim');
let sheetOpen = false, confirmSair = false;
function syncUI() {
  if (!user) { $sync.hidden = true; return; }
  $sync.hidden = false;
  let cls = 'ok', txt = 'Sincronizado';
  if (erroBanco === 'permission-denied') { cls = 'err'; txt = 'Sem acesso'; }
  else if (!navigator.onLine) { cls = pendentes ? 'pend' : 'off'; txt = pendentes ? 'Offline · a enviar' : 'Offline'; }
  else if (pendentes) { cls = 'pend'; txt = 'Enviando…'; }
  else if (!areaAtiva) { cls = 'ok'; txt = 'Conectado'; }
  else if (doCache) { cls = 'off'; txt = 'Conectando…'; }
  $sync.className = 'sync ' + cls;
  $sync.lastElementChild.textContent = txt;
  if (sheetOpen) renderSheet();
}
function renderSheet() {
  const estado = !navigator.onLine ? 'Sem conexão. As marcações ficam guardadas neste aparelho e são enviadas quando o sinal voltar.'
    : erroBanco === 'permission-denied' ? 'Seu usuário não tem acesso ao banco.' : pendentes ? 'Enviando marcações…' : 'Conectado e em dia.';
  $scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t">
    <h2 id="sh-t">Sincronização</h2>
    <p>${estado}</p>
    <dl class="kv"><dt>Usuário</dt><dd>${esc(user && user.email)}</dd>
      <dt>A enviar</dt><dd class="num">${areaAtiva ? (pendentes ? `há marcações a enviar (área ${areaAtiva})` : 'nada pendente') : '—'}</dd>
      <dt>Versão</dt><dd class="num">${VERSAO}</dd></dl>
    <div class="row"><button class="btn pri" data-act="close">Fechar</button></div>
    <hr>
    ${exportHtml()}
    <hr>
    ${confirmSair
      ? `<p>${pendentes ? `<b>Há marcações ainda não enviadas.</b> Se sair agora, essas marcações podem ser perdidas. ` : ''}Confirma a saída?</p>
         <div class="row"><button class="btn danger" data-act="sair-ok">Sair</button><button class="btn" data-act="sair-no">Cancelar</button></div>`
      : `<div class="row"><button class="btn" data-act="sair">Sair da conta</button></div>`}
  </div>`;
}
function openSheet() { sheetOpen = true; confirmSair = false; if (exp.etapa !== 'liberado') exp = { etapa: 'fechado', msg: '', senha: '' }; renderSheet(); $scrim.hidden = false; }
function closeSheet() { sheetOpen = false; $scrim.hidden = true; $scrim.innerHTML = ''; }
$sync.addEventListener('click', openSheet);
$scrim.addEventListener('click', async e => {
  if (e.target === $scrim) return closeSheet();
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'close') closeSheet();
  else if (act === 'sair') { confirmSair = true; renderSheet(); }
  else if (act === 'sair-no') { confirmSair = false; renderSheet(); }
  else if (act === 'exp-abrir') { exp = { etapa: 'senha', msg: '', senha: '' }; renderSheet(); const i = document.getElementById('expsenha'); if (i) i.focus(); }
  else if (act === 'exp-ok') await conferirSenha();
  else if (act === 'exp-json' || act === 'exp-csv' || act === 'exp-acoes') await exportar(act.slice(4));
  else if (act === 'sair-ok') { closeSheet(); if (unsub) unsub(); unsub = null; areaAtiva = null; await store.sair(); }
});
$scrim.addEventListener('input', e => { if (e.target.id === 'expsenha') exp.senha = e.target.value; });
$scrim.addEventListener('keydown', e => { if (e.target.id === 'expsenha' && e.key === 'Enter') { e.preventDefault(); conferirSenha(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen) closeSheet(); });

/* ---------------- exportação (protegida por senha) ----------------
   A senha não fica escrita no código: guardamos só o resumo SHA-256 dela e comparamos com o resumo do que foi digitado. */
const SENHA_SHA256 = '4b106388b810de25f640a68448b73c64c9233d96cdb384f724afdc2fda42821f';
let exp = { etapa: 'fechado', msg: '', senha: '' };
async function sha256(txt) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
function exportHtml() {
  const msg = exp.msg ? `<div class="msg ${exp.msgCls || ''}">${esc(exp.msg)}</div>` : '';
  if (exp.etapa === 'fechado') return `<div class="row"><button class="btn" data-act="exp-abrir">Exportar dados…</button></div>`;
  if (exp.etapa === 'senha') return `<p><b>Exportar dados.</b> Digite a senha de exportação.</p>${msg}
    <label class="field" for="expsenha">Senha<input id="expsenha" type="password" autocomplete="off" value="${esc(exp.senha)}"></label>
    <div class="row"><button class="btn pri" data-act="exp-ok">Continuar</button></div>`;
  return `<p><b>Exportar dados</b> de todas as áreas.</p>${msg}
    <div class="row"><button class="btn pri" data-act="exp-csv" ${exp.rodando ? 'disabled' : ''}>Planilha (CSV)</button>
      ${temAcoes() ? `<button class="btn" data-act="exp-acoes" ${exp.rodando ? 'disabled' : ''}>Ações (CSV)</button>` : ''}
      <button class="btn" data-act="exp-json" ${exp.rodando ? 'disabled' : ''}>Backup (JSON)</button></div>`;
}
async function conferirSenha() {
  let ok = false;
  try { ok = (await sha256(exp.senha || '')) === SENHA_SHA256; } catch (e) {}
  exp = ok ? { etapa: 'liberado', msg: '' } : { etapa: 'senha', msg: 'Senha incorreta.', msgCls: 'err', senha: '' };
  renderSheet();
}
function baixar(nome, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const lnk = document.createElement('a'); lnk.href = url; lnk.download = nome;
  document.body.appendChild(lnk); lnk.click(); lnk.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const dataHora = d => d ? d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
const tsData = ts => (ts && ts.toDate) ? ts.toDate() : null;
async function exportar(formato) {
  if (exp.etapa !== 'liberado') return;
  exp.rodando = true; exp.msg = 'Lendo o banco…'; exp.msgCls = ''; renderSheet();
  try {
    const { docs: brutos, doCache: cache } = await store.lerTudo();
    const carimbo = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', 'h');
    // separador ";" e BOM UTF-8: o Excel em português abre direto, com acentos corretos
    const cel = v => { const x = String(v == null ? '' : v); return /[;"\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const baixarCsv = (nome, linhas) => baixar(nome, '\ufeff' + linhas.map(l => l.map(cel).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
    if (formato === 'json') {
      const conv = v => v && typeof v.toDate === 'function' ? v.toDate().toISOString()
        : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])) : v;
      const saida = { exportadoEm: new Date().toISOString(), exportadoPor: user.email, versaoApp: VERSAO,
        fonte: cache ? 'cache do aparelho (sem conexão)' : 'servidor', colecao: 'centrais',
        documentos: brutos.map(d => ({ id: d.id, ...conv(d.data) })) };
      baixar(`comissionamento-eber_${carimbo}.json`, JSON.stringify(saida, null, 1), 'application/json');
    } else if (formato === 'acoes') {
      // uma linha por ação de inspeção de todas as áreas (concluídas ou não)
      const ck = {};
      brutos.forEach(d => Object.assign(ck, d.data.ck || {}));
      const linhas = [['Nº', 'Código', 'Área', 'Tag', 'Local na lista', 'Problema', 'Data adicionado', 'Concluída', 'Concluída por', 'Concluída em']];
      for (const ar of AREAS) for (const x of acoesDe(ar.id)) {
        const reg = ck[`${ar.id}:ACOES:${x.id}~ACO`] || {}, on = (reg.checked || {})[x.id] === true;
        linhas.push([parseInt(x.id.replace(/\D/g, ''), 10), x.id, ar.id, x.tag || 'Geral da área', x.loc || ar.id, x.t,
          x.d ? x.d.split('-').reverse().join('/') : '', on ? 'Sim' : 'Não', on ? (reg.por || '') : '', on ? dataHora(tsData(reg.em)) : '']);
      }
      baixarCsv(`acoes-eber_${carimbo}.csv`, linhas);
    } else {
      // uma linha por item de checklist, de todos os equipamentos das áreas (marcados ou não)
      const ck = {};
      brutos.forEach(d => { const m = d.data.ck || {}; for (const k in m) { const [l, s] = k.split('~'); ck[l.replace(/:/g, '.') + '~' + s] = m[k]; } });
      const cab = ['Área', 'Equipamento central', 'Nível', 'Tag', 'Descrição', 'Tipo', 'Especialidade', 'Status do checklist',
        'Itens marcados', 'Itens do checklist', 'Código do item', 'Tarefa', 'Onde', 'FGA', 'Marcado', 'Última alteração (checklist) por', 'Última alteração (checklist) em', 'Local na lista'];
      const linhas = [cab];
      const NIVEL = ['Equipamento central', 'Equipamento ligado', 'Subequipamento'];
      for (const ar of AREAS) {
        const a = await carregarArea(ar.id);
        for (const c of a.centrais) for (const it of c.itens) for (const s of SECS) {
          const list = listaDe(it, s); if (!list) continue;
          const reg = ck[docId(it.loc, s)] || {}, chk = reg.checked || {};
          const feitos = list.filter(t => chk[t.id] === true).length;
          const status = feitos === 0 ? 'Não iniciado' : feitos === list.length ? 'Aprovado' : 'Em andamento';
          for (const t of list) linhas.push([a.area, nomeCentral(c), NIVEL[it.n], it.tag, it.desc, L.tipos[it.cat].nome, SEC[s], status,
            feitos, list.length, t.id, t.t, ONDE[t.o], t.fga ? 'X' : '', chk[t.id] === true ? 'Sim' : 'Não', reg.por || '', dataHora(tsData(reg.em)), it.loc]);
        }
      }
      baixarCsv(`comissionamento-eber_${carimbo}.csv`, linhas);
    }
    exp.msg = (cache ? 'Atenção: sem conexão, o arquivo saiu com os dados guardados neste aparelho. ' : '') + 'Arquivo gerado. Veja a pasta de downloads.';
    exp.msgCls = cache ? '' : 'ok';
  } catch (e) {
    exp.msg = 'Não foi possível exportar (' + (e && (e.code || e.message) || 'erro') + ').'; exp.msgCls = 'err';
  }
  exp.rodando = false; renderSheet();
}
window.addEventListener('online', syncUI);
window.addEventListener('offline', syncUI);

/* ---------------- toast ---------------- */
const $toast = document.getElementById('toast'); let toastT = 0;
function toast(msg) { $toast.textContent = msg; $toast.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => $toast.hidden = true, 2600); }

/* ---------------- navegação ---------------- */
let nav = { v: 'areas' };
let filt = { q: '', only: false };
const $view = document.getElementById('view'), $crumb = document.getElementById('crumb'), $back = document.getElementById('back'), $nav = document.getElementById('navbar');
async function go(n) {
  if (n.a) {
    if (!AREA[n.a]) { $view.innerHTML = '<div class="spinner">Carregando área…</div>'; $nav.innerHTML = ''; }
    try { await carregarArea(n.a); } catch (e) { $view.innerHTML = `<div class="banner">Não foi possível carregar a área ${esc(n.a)}. Verifique a conexão e tente de novo.</div>`; return; }
    abrirArea(n.a);
  }
  nav = n;
  if (n.v === 'central' && filt.c !== n.c) filt = { q: '', only: false, c: n.c };
  if (n.v === 'acoes') { filtA = { q: '', pend: false }; capturarAcoes(); }
  if (n.v !== 'check' && n.v !== 'central') atualizarAcoes();
  render(); window.scrollTo(0, 0);
}
$back.addEventListener('click', () => {
  if (nav.v === 'check') go({ v: 'central', a: nav.a, c: AREA[nav.a].EQ[nav.loc].c });
  else if (nav.v === 'central' || nav.v === 'acoes') go({ v: 'area', a: nav.a });
  else go({ v: 'areas' });
});

function sbar(g) { return `<div class="sbar" aria-hidden="true"><span class="o" style="width:${pct(g.ok, g.n)}%"></span><span class="p" style="width:${pct(g.prog, g.n)}%"></span></div>`; }
function metaLine(g) { return `<div class="card-meta"><span><b class="num">${g.ok}</b> de <span class="num">${g.n}</span> checklists aprovados${g.prog ? ` · <span class="num">${g.prog}</span> em andamento` : ''}</span><span class="num">${pct(g.di, g.ti)}% dos itens</span></div>`; }
const legend = `<div class="legend"><span><i class="sw"></i>Não iniciado</span><span><i class="sw p"></i>Em andamento</span><span><i class="sw o"></i>Aprovado</span><span><i class="sw na"></i>Não se aplica</span></div>`;
function crumb(b, s) { $crumb.innerHTML = `<b>${esc(b)}</b><span>${esc(s)}</span>`; }
const nomeCentral = c => c.pseudo ? 'Grupo ' + c.tag : c.tag;
const descCentral = c => c.pseudo ? c.desc : tcase(c.desc);

function render() {
  $back.hidden = !user || nav.v === 'areas';
  document.body.classList.toggle('com-nav', !!user && nav.v === 'check');
  $nav.innerHTML = '';
  if (!store.configurado) return viewSetup();
  if (!authPronto) { $view.innerHTML = '<div class="spinner">Carregando…</div>'; return; }
  if (!user) return viewLogin();
  if (erroBanco === 'permission-denied' || acesso === false) return viewSemAcesso();
  if (nav.v === 'areas') viewAreas();
  else if (nav.v === 'area') viewArea();
  else if (nav.v === 'central') viewCentral();
  else if (nav.v === 'acoes') viewAcoes();
  else viewCheck();
}
function refresh() {
  if (!user) return;
  if (nav.v === 'check') { updateCheck(); return; }
  if (nav.v === 'acoes') { atualizarTelaAcoes(); return; }
  const y = window.scrollY;
  const q = document.getElementById('q'), focused = q && document.activeElement === q, sel = q && [q.selectionStart, q.selectionEnd];
  render(); window.scrollTo(0, y);
  if (focused) { const q2 = document.getElementById('q'); if (q2) { q2.focus(); try { q2.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
}

/* ---------------- telas ---------------- */
function viewSetup() {
  crumb('Comissionamento', 'Configuração pendente');
  $view.innerHTML = `<div class="login">${LOGOS}
    <h1>Falta configurar o Firebase</h1>
    <p>Cole a configuração do app web do Firebase no arquivo <b>js/firebase-config.js</b>, como descrito no README do repositório.</p></div>`;
}

let loginMsg = null;
function viewLogin() {
  crumb('Comissionamento', 'EBER Bioenergia · Montes Claros de Goiás/GO');
  $view.innerHTML = `<form class="login" id="flogin" novalidate>
    ${LOGOS}
    <h1>Comissionamento pré-partida</h1>
    <p>Entre com o e-mail e a senha cadastrados pelo administrador.</p>
    ${loginMsg ? `<div class="msg ${loginMsg.cls}">${esc(loginMsg.txt)}</div>` : ''}
    <label class="field" for="em">E-mail<input id="em" type="email" autocomplete="username" inputmode="email" required></label>
    <label class="field" for="pw">Senha<input id="pw" type="password" autocomplete="current-password" required></label>
    <button class="btn pri" type="submit" id="bentrar">Entrar</button>
    <button class="linkbtn" type="button" id="besqueci">Esqueci a senha</button>
  </form>`;
  const f = document.getElementById('flogin');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const em = document.getElementById('em').value, pw = document.getElementById('pw').value;
    if (!em || !pw) { loginMsg = { cls: 'err', txt: 'Preencha e-mail e senha.' }; return viewLogin(); }
    const b = document.getElementById('bentrar'); b.disabled = true; b.textContent = 'Entrando…';
    try { await store.entrar(em, pw); loginMsg = null; }
    catch (err) {
      const c = err && err.code || '';
      loginMsg = { cls: 'err', txt: c === 'auth/network-request-failed' ? 'Sem conexão. O primeiro acesso em cada aparelho precisa de internet.'
        : c === 'auth/too-many-requests' ? 'Muitas tentativas. Aguarde alguns minutos e tente de novo.'
        : 'E-mail ou senha incorretos.' };
      viewLogin(); document.getElementById('em').value = em;
    }
  });
  document.getElementById('besqueci').addEventListener('click', async () => {
    const em = document.getElementById('em').value;
    if (!em) { loginMsg = { cls: 'err', txt: 'Digite seu e-mail acima e toque de novo em "Esqueci a senha".' }; return viewLogin(); }
    try { await store.redefinirSenha(em); loginMsg = { cls: 'ok', txt: 'Se o e-mail estiver cadastrado, você vai receber um link para criar uma nova senha.' }; }
    catch (err) { loginMsg = { cls: 'err', txt: 'Não foi possível enviar agora. Verifique o e-mail e a conexão.' }; }
    viewLogin(); document.getElementById('em').value = em;
  });
}

function viewSemAcesso() {
  crumb('Comissionamento', 'Acesso pendente');
  $view.innerHTML = `<div class="login">${LOGOS}
    <h1>Acesso ainda não liberado</h1>
    <p>Seu login funcionou, mas o administrador ainda precisa liberar este usuário. Envie a ele o código abaixo.</p>
    <div class="msg"><b>${esc(user.email)}</b><br><span class="num" style="word-break:break-all">${esc(user.uid)}</span></div>
    <button class="btn" type="button" id="bcopiar">Copiar código</button>
    <button class="btn" type="button" id="bsair2">Sair</button></div>`;
  document.getElementById('bcopiar').addEventListener('click', async () => { try { await navigator.clipboard.writeText(user.uid); toast('Código copiado'); } catch (e) {} });
  document.getElementById('bsair2').addEventListener('click', () => store.sair());
}

function areaResumo(ar) {
  const a = AREA[ar.id];
  if (a && areaAtiva === ar.id && !doCache) return aggregate(a, allItens(a));
  // resumo guardado no aparelho só vale se foi calculado com a mesma lista de equipamentos que está no ar
  // (mesmo número de checklists e de itens); se a lista mudou (ex.: equipamentos retirados), é descartado
  const r = lsGet('resumo-' + ar.id);
  return r && r.n === ar.checklists && r.ti === ar.itens ? r : null;
}
const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
function acoesLinha(ar) {   // linha "Ações" no cartão de cada área da tela inicial
  if (!temAcoes()) return '';
  const n = acoesDe(ar.id).length;
  if (!n) return '<div class="card-acoes"><span><span class="rot">Ações</span>nenhuma registrada</span></div>';
  let c = null;
  if (AREA[ar.id] && areaAtiva === ar.id && !doCache) c = acContar(ar.id);
  else { const r = lsGet('resumo-' + ar.id); if (r && r.ac && r.ac.n === n) c = r.ac; }   // só vale se a lista de ações não mudou
  if (!c) return `<div class="card-acoes"><span><span class="rot">Ações</span><span class="num">${n}</span> ${n === 1 ? 'registrada' : 'registradas'}</span></div>`;
  const falta = c.n - c.ok;
  return `<div class="card-acoes"><span><span class="rot">Ações</span><b class="num">${c.ok}</b> de <span class="num">${c.n}</span> concluídas</span>${falta
    ? `<span class="pill prog">${plural(falta, 'pendente', 'pendentes')}</span>` : '<span class="pill ok">Concluídas</span>'}</div>`;
}
function viewAreas() {
  crumb('Comissionamento', 'EBER Bioenergia · Montes Claros de Goiás/GO');
  $view.innerHTML = `<section class="hero">${LOGOS}
      <h1>Comissionamento pré-partida</h1><p>Mecânica · Elétrica · Instrumentação · Operação</p></section>
    <h2 class="lbl">Áreas</h2>
    <div class="list">${AREAS.map(ar => {
      const g = areaResumo(ar);
      return `<button class="card" data-go="area" data-a="${ar.id}">
        <div class="card-top"><span class="tag">Área ${ar.id}</span><span class="desc">${esc(ar.nome)}</span></div>
        ${g ? sbar(g) + metaLine(g) : `<div class="card-note"><span class="num">${ar.checklists}</span> checklists · <span class="num">${ar.equip}</span> equipamentos — abra para ver o andamento</div>`}
        ${acoesLinha(ar)}
      </button>`; }).join('')}</div>
    <p class="who" style="margin-top:18px">${esc(user.email)}</p>`;
}
function viewArea() {
  const a = AREA[nav.a];
  crumb('Área ' + a.area, a.nome);
  const tot = aggregate(a, allItens(a));
  const ac = acContar(a.area), falta = ac.n - ac.ok;
  const blocoAcoes = !ac.n ? '' : `<h2 class="lbl">Ações de inspeção</h2>
    <div class="list"><button class="card" data-go="acoes" data-a="${a.area}">
      <div class="card-top"><span class="tag">Ações</span><span class="desc">Pendências levantadas nas inspeções desta área</span>${falta
        ? `<span class="pill prog">${plural(falta, 'pendente', 'pendentes')}</span>` : '<span class="pill ok">Concluídas</span>'}</div>
      <div class="sbar" aria-hidden="true"><span class="o" style="width:${pct(ac.ok, ac.n)}%"></span></div>
      <div class="card-meta"><span><b class="num">${ac.ok}</b> de <span class="num">${ac.n}</span> concluídas</span><span class="num">${pct(ac.ok, ac.n)}%</span></div>
    </button></div>`;
  $view.innerHTML = `<div class="eqhead"><span class="tag">Área ${a.area}</span><p>${esc(a.nome)}</p></div>
    <div class="prog-wrap">${sbar(tot)}${metaLine(tot)}</div>
    ${blocoAcoes}
    <h2 class="lbl">Equipamentos centrais</h2>
    <div class="list">${a.centrais.map(c => {
      const g = aggregate(a, c.itens);
      const st = g.ok === g.n ? '<span class="pill ok">Aprovado</span>' : (g.ok + g.prog) ? '<span class="pill prog">Em andamento</span>' : '';
      return `<button class="card" data-go="central" data-a="${a.area}" data-c="${esc(c.tag)}">
        <div class="card-top"><span class="tag">${esc(nomeCentral(c))}</span><span class="desc">${esc(descCentral(c))}</span>${st}</div>
        ${sbar(g)}
        <div class="card-meta"><span><span class="num">${c.itens.length}</span> equipamentos · <b class="num">${g.ok}</b>/<span class="num">${g.n}</span> checklists aprovados</span><span class="num">${pct(g.di, g.ti)}% dos itens</span></div>
      </button>`; }).join('')}</div>
    ${legend}`;
}
function viewCentral() {
  const a = AREA[nav.a], c = a.CEN[nav.c];
  crumb(nomeCentral(c), descCentral(c));
  const g = aggregate(a, c.itens);
  const q = filt.q.trim().toUpperCase();
  const rows = c.itens.filter(it => {
    if (q && !(it.tag.toUpperCase().includes(q) || (it.desc || '').toUpperCase().includes(q))) return false;
    if (filt.only && SECS.every(s => { const st = stat(a, it.loc, s); return !st || st.s === 'ok'; })) return false;
    return true;
  });
  $view.innerHTML = `<div class="eqhead"><span class="tag">${esc(nomeCentral(c))}</span><p>${esc(descCentral(c))}</p></div>
    <div class="prog-wrap">${sbar(g)}${metaLine(g)}</div>
    <div class="tools"><input class="search" id="q" type="search" placeholder="Buscar tag" value="${esc(filt.q)}" autocomplete="off">
      <div class="seg" role="group" aria-label="Filtro"><button data-f="all" aria-pressed="${!filt.only}">Todos</button><button data-f="only" aria-pressed="${filt.only}">Pendentes</button></div></div>
    <div class="mx" role="table" aria-label="Matriz de status por especialidade">
      <div class="mx-h" role="row"><div>Equipamento</div>${SECS.map(s => `<div title="${SEC[s]}">${s}<small class="num">${g.bySec[s].ok}/${g.bySec[s].n}</small></div>`).join('')}</div>
      ${rows.length ? rows.map(it => `<div class="mx-r n${it.n}" role="row">
        <div class="eq"><span class="tag">${esc(it.tag)}</span><small>${esc(tcase(it.desc))}</small></div>
        ${SECS.map(s => cellHtml(a, it, s)).join('')}</div>`).join('') : `<div class="empty">Nenhum equipamento neste filtro.</div>`}
    </div>${legend}`;
}
function cellHtml(a, it, s) {
  const st = stat(a, it.loc, s);
  if (!st) return `<span class="cell na" role="cell" aria-label="${SEC[s]}: não se aplica"></span>`;
  const lab = `${SEC[s]} de ${it.tag}: ${st.s === 'ok' ? 'aprovado' : st.s === 'prog' ? 'em andamento' : 'não iniciado'}, ${st.done} de ${st.total}`;
  return `<button class="cell ${st.s}" role="cell" data-go="check" data-a="${a.area}" data-loc="${esc(it.loc)}" data-sec="${s}" aria-label="${esc(lab)}">${st.s === 'ok' ? CHECK_SVG : `<span class="num">${st.done}/${st.total}</span>`}</button>`;
}

function pathOf(it) { return it.loc.split('.').slice(1).map(p => /^[A-D]$/.test(p) ? 'Grupo ' + p : p).join(' › '); }
function fmtData(ts) {
  try { const d = ts && ts.toDate ? ts.toDate() : null; if (!d) return ''; return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
}
function viewCheck() {
  const a = AREA[nav.a], it = a.EQ[nav.loc], sec = nav.sec, list = listaDe(it, sec);
  const ch = checkedOf(docId(it.loc, sec)), tipo = L.tipos[it.cat];
  crumb(it.tag, SEC[sec] + ' · ' + pathOf(it));
  $view.innerHTML = `<div class="eqhead"><span class="tag">${esc(it.tag)}</span><p>${esc(tcase(it.desc))}</p>
      <div class="chips"><span class="pill">${esc(tipo.nome)}</span><span class="pill">${SEC[sec]}</span><span class="pill">Checklist ${esc(nomeLista(it, sec))}</span></div></div>
    <div class="prog-wrap" id="pw"></div>
    <div class="items">${list.map(t => {
      const on = ch[t.id] === true;
      return `<label class="item${on ? ' done' : ''}${t.pend ? ' pend' : ''}">
        <input type="checkbox" data-item="${esc(t.id)}" ${on ? 'checked' : ''} aria-label="${esc(t.id)}">
        <div class="it-body"><div class="it-head"><span class="it-id">${esc(t.id)}</span><span class="onde ${t.o}">${ONDE[t.o]}</span>${t.fga ? '<span class="fga">FGA</span>' : ''}</div>
          <div class="it-t">${esc(t.t)}</div>
          ${t.crit ? `<div class="crit"><b>Critério:</b> ${esc(t.crit)}</div>` : ''}
          ${t.pend ? '<div class="pendtxt">Depende de resposta do projetista</div>' : ''}</div>
      </label>`; }).join('')}</div>`;
  const seq = a.CEN[it.c].itens.filter(x => listaDe(x, sec)), i = seq.indexOf(it);
  const prev = seq[i - 1], next = seq[i + 1];
  $nav.innerHTML = `<nav class="nav"><div class="nav-in">
    <button ${prev ? `data-go="check" data-a="${a.area}" data-loc="${esc(prev.loc)}" data-sec="${sec}"` : 'disabled'} aria-label="Equipamento anterior">‹ ${prev ? esc(prev.tag) : ''}</button>
    <div class="mid"><b>${SEC[sec]}</b><span class="num">${i + 1} de ${seq.length}</span></div>
    <button ${next ? `data-go="check" data-a="${a.area}" data-loc="${esc(next.loc)}" data-sec="${sec}"` : 'disabled'} aria-label="Próximo equipamento">${next ? esc(next.tag) : ''} ›</button>
  </div></nav>`;
  updateProgress();
}
function updateProgress() {
  const a = AREA[nav.a], st = stat(a, nav.loc, nav.sec), d = docs[docId(nav.loc, nav.sec)];
  const pill = st.s === 'ok' ? '<span class="pill ok">Aprovado</span>' : st.s === 'prog' ? '<span class="pill prog">Em andamento</span>' : '<span class="pill">Não iniciado</span>';
  const quando = d && d.por ? `<div class="upd">Última alteração: ${esc(d.por)}${fmtData(d.em) ? ' · ' + fmtData(d.em) : ''}</div>` : '';
  document.getElementById('pw').innerHTML = `<div class="prog-top"><span><b class="num">${st.done}</b> <span class="num" style="color:var(--muted)">de ${st.total} itens</span></span>${pill}</div>
    <div class="sbar"><span class="${st.s === 'ok' ? 'o' : 'p'}" style="width:${pct(st.done, st.total)}%"></span></div>${quando}`;
}
function updateCheck() {
  const ch = checkedOf(docId(nav.loc, nav.sec));
  document.querySelectorAll('[data-item]').forEach(inp => {
    const on = ch[inp.dataset.item] === true;
    if (inp.checked !== on) inp.checked = on;
    inp.closest('.item').classList.toggle('done', on);
  });
  updateProgress();
}

/* ---------------- lista de ações da área ---------------- */
const semAcento = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const diaMes = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
function feitoTxt(area, id) {
  const d = docs[docId(acLoc(area, id), 'ACO')] || {};
  const quem = d.por ? (user && d.por === user.email ? 'você' : d.por) : '';
  let quando = '';
  try { const t = d.em && d.em.toDate ? d.em.toDate() : null; if (t) quando = t.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' às ' + t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch (e) {}
  return 'Concluída' + (quem ? ' por ' + quem : '') + (quando ? ' · ' + quando : '');
}
function acaoHtml(x) {
  const on = acFeita(nav.a, x.id);
  const chip = x.tag ? `<span class="chip-tag">${esc(x.tag)}</span>` : '<span class="onde">Geral da área</span>';
  const meta = [x.pai ? esc(x.pai) : '', x.d ? 'Adicionada em ' + diaMes(x.d) : ''].filter(Boolean).map(t => `<span>${t}</span>`).join('');
  return `<label class="item${on ? ' done' : ''}">
    <input type="checkbox" data-acao="${esc(x.id)}" ${on ? 'checked' : ''} aria-label="${esc(x.id)}">
    <div class="it-body"><div class="it-head"><span class="it-id">${esc(x.id)}</span>${chip}</div>
      <div class="it-t">${esc(x.t)}</div>
      ${meta ? `<div class="it-meta">${meta}</div>` : ''}
      <div class="feito" data-feito ${on ? '' : 'hidden'}>${on ? esc(feitoTxt(nav.a, x.id)) : ''}</div></div>
  </label>`;
}
function viewAcoes() {
  if (!baseA || baseA.a !== nav.a) capturarAcoes();
  crumb('Ações', 'Área ' + nav.a);
  $view.innerHTML = `<div class="eqhead"><span class="tag">Ações</span><p>Área ${esc(nav.a)}</p></div>
    <div class="prog-wrap" id="pwa"></div>
    <div class="tools"><input class="search" id="qa" type="search" placeholder="Buscar ação ou tag" value="${esc(filtA.q)}" autocomplete="off">
      <div class="seg" role="group" aria-label="Filtro"><button data-fa="pend" aria-pressed="${filtA.pend}">Pendentes</button><button data-fa="todas" aria-pressed="${!filtA.pend}">Todas</button></div></div>
    <div id="lista-acoes"></div>`;
  listaAcoes(); progAcoes();
}
function listaAcoes() {
  // a divisão entre pendentes e concluídas usa a situação de quando a lista foi aberta (baseA):
  // a ação que a pessoa acabou de concluir fica onde estava, em verde, até ela sair da lista
  const q = semAcento(filtA.q.trim());
  const todas = acoesDe(nav.a).filter(x => !q || semAcento([x.id, x.tag, x.pai, x.loc, x.t].join(' ')).includes(q));
  const pend = todas.filter(x => !baseA.feita[x.id]), feitas = todas.filter(x => baseA.feita[x.id]);
  const grupo = (titulo, l) => l.length ? `<div class="grp">${titulo}<span class="num">${l.length}</span></div><div class="items">${l.map(acaoHtml).join('')}</div>` : '';
  let h = q ? `<div class="busca-res">${plural(todas.length, 'ação', 'ações')} com “${esc(filtA.q.trim())}”</div>` : '';
  if (filtA.pend) h += pend.length ? `<div class="items">${pend.map(acaoHtml).join('')}</div>` : `<div class="empty">Nenhuma ação pendente${q ? ' nesta busca' : ' nesta área'}.</div>`;
  else h += (grupo('Pendentes', pend) + grupo('Concluídas', feitas)) || `<div class="empty">Nenhuma ação${q ? ' nesta busca' : ' registrada nesta área'}.</div>`;
  document.getElementById('lista-acoes').innerHTML = h;
}
function progAcoes() {
  const el = document.getElementById('pwa'); if (!el) return;
  const c = acContar(nav.a), falta = c.n - c.ok;
  el.innerHTML = `<div class="prog-top"><span><b class="num">${c.ok}</b> <span class="num" style="color:var(--muted)">de ${c.n} concluídas</span></span>${falta
    ? `<span class="pill prog">${plural(falta, 'pendente', 'pendentes')}</span>` : '<span class="pill ok">Todas concluídas</span>'}</div>
    <div class="sbar"><span class="o" style="width:${pct(c.ok, c.n)}%"></span></div>`;
}
function atualizarTelaAcoes() {
  // chegou a primeira leitura do servidor e a pessoa ainda não marcou nada: refaz a divisão pendentes/concluídas
  if (baseA && !baseA.tocou && baseA.cache && !doCache) { capturarAcoes(); listaAcoes(); progAcoes(); return; }
  document.querySelectorAll('[data-acao]').forEach(inp => {
    const on = acFeita(nav.a, inp.dataset.acao), item = inp.closest('.item'), f = item.querySelector('[data-feito]');
    if (inp.checked !== on) inp.checked = on;
    item.classList.toggle('done', on);
    f.hidden = !on; f.textContent = on ? feitoTxt(nav.a, inp.dataset.acao) : '';
  });
  progAcoes();
}

/* ---------------- eventos ---------------- */
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]');
  if (g && !g.disabled) {
    const v = g.dataset.go, d = g.dataset;
    go(v === 'area' || v === 'acoes' ? { v, a: d.a } : v === 'central' ? { v, a: d.a, c: d.c } : v === 'check' ? { v, a: d.a, loc: d.loc, sec: d.sec } : { v });
    return;
  }
  const f = e.target.closest('[data-f]');
  if (f) { filt.only = f.dataset.f === 'only'; refresh(); return; }
  const fa = e.target.closest('[data-fa]');
  if (fa) { filtA.pend = fa.dataset.fa === 'pend'; capturarAcoes(); viewAcoes(); }
});
$view.addEventListener('change', e => {
  const ac = e.target.closest('[data-acao]');
  if (ac) {   // check de uma ação: grava só essa ação, pela mesma função dos checklists
    const cod = ac.dataset.acao, loc = acLoc(nav.a, cod), did = docId(loc, 'ACO');
    if (baseA) baseA.tocou = true;
    docs[did] = Object.assign({}, docs[did], { checked: Object.assign({}, checkedOf(did), { [cod]: ac.checked }), por: user.email, em: { toDate: () => new Date() } });
    store.marcarItem(nav.a, 'ACOES', loc, 'ACO', cod, ac.checked, user.email).catch(err => {
      // se o banco recusar, o Firestore desfaz a marcação na tela; o resto do app continua funcionando
      if (err && err.code === 'permission-denied') toast('O banco recusou esta marcação. Avise o administrador.');
    });
    atualizarTelaAcoes();
    return;
  }
  const inp = e.target.closest('[data-item]'); if (!inp) return;
  const a = AREA[nav.a], id = docId(nav.loc, nav.sec);
  const before = stat(a, nav.loc, nav.sec).s;
  // aplica na tela na hora; o snapshot do Firestore (cache local) confirma logo em seguida
  docs[id] = Object.assign({}, docs[id], { checked: Object.assign({}, checkedOf(id), { [inp.dataset.item]: inp.checked }), por: user.email });
  store.marcarItem(nav.a, a.EQ[nav.loc].c, nav.loc, nav.sec, inp.dataset.item, inp.checked, user.email).catch(err => {
    if (err && err.code === 'permission-denied') { erroBanco = 'permission-denied'; render(); syncUI(); }
  });
  inp.closest('.item').classList.toggle('done', inp.checked);
  updateProgress();
  if (stat(a, nav.loc, nav.sec).s === 'ok' && before !== 'ok') toast('Checklist aprovado · ' + a.EQ[nav.loc].tag + ' · ' + SEC[nav.sec]);
});
$view.addEventListener('input', e => {
  if (e.target.id === 'q') { filt.q = e.target.value; refresh(); }
  else if (e.target.id === 'qa') { filtA.q = e.target.value; listaAcoes(); }
});

/* ---------------- início ---------------- */
let acesso = null, authPronto = false;
async function iniciar() {
  try {
    if (!store.configurado) { render(); return; }
    [L, AREAS] = await Promise.all([carregarJSON('dados/listas.json'), carregarJSON('dados/areas.json'), carregarAcoes(false)]);
  } catch (e) {
    $view.innerHTML = '<div class="banner">Não foi possível carregar os dados do app. Abra com internet pelo menos uma vez neste aparelho.</div>';
    return;
  }
  store.aoMudarUsuario(async u => {
    user = u; acesso = null; erroBanco = ''; authPronto = true;
    if (u) acesso = await store.acessoLiberado(u.uid);   // null = offline: segue com o que está no aparelho
    else { if (unsub) unsub(); unsub = null; areaAtiva = null; nav = { v: 'areas' }; }
    render(); syncUI();
  });
  render();
  atualizarAcoes(true);
}
iniciar();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
