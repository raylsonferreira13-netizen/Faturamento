'use strict';

const STORE_KEY = 'cosampa-faturamento-v1';
const UI_KEY = 'cosampa-faturamento-ui-v1';
const TEMA_KEY = 'cosampa-tema';
const SOMA_LINHA_KEY = 'cosampa-matriz-soma-linha'; // '1' = mostra a soma simples das linhas da matriz
const VISTOS_KEY = 'cosampa-avisos-vistos';
const FONTE_KEY = 'cosampa-fonte-url';
// Planilha publicada no Google Planilhas ("Publicar na Web"). Pode ser trocada em Configurações.
const FONTE_PADRAO = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvUx26o2N7fDCT2QHL-e-ut4tgs-mgySP6rhGBEkZqWLZ1MzVg4HmZtcQqU7b0hFQkb7B3SGv4P1OS/pubhtml';
const INTERVALO_SYNC = 10 * 60 * 1000;
const { brl, compact, esc } = CHARTS;
const $ = s => document.querySelector(s);
const R = (root, k) => root.querySelector(`[data-r="${k}"]`);

const STATUS = [
  { key: 'Recebida', name: 'Recebida', color: 'var(--good)' },
  { key: 'Faturada', name: 'Faturada', color: 'var(--warning)' },
  { key: 'Medida', name: 'Medida (a faturar)', color: 'var(--serious)' }
];
const COMPOS = [
  { key: 'rec', name: 'Recebido', color: 'var(--c-rec)' },
  { key: 'fat', name: 'Faturado a receber', color: 'var(--c-fat)' },
  { key: 'med', name: 'Medido a faturar', color: 'var(--c-med)' },
  { key: 'saldo', name: 'A medir', color: 'var(--c-saldo)' }
];
const ROTAS = ['geral', 'obra', 'medicoes', 'config'];

let data = null;         // o que o usuário logado pode ver (só as obras liberadas)
let dataCompleta = null; // planilha inteira, como foi lida
let ui = { tab: 'geral', modo: 'total', obra: 0, f: {}, de: null, ate: '' };

function store(key, val) { try { localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val)); } catch (e) { /* armazenamento indisponível */ } }
function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
function loadTxt(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000);
}
const pct = (a, b) => (b ? (a / b * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—');

// ---------- Tema (tela clara / escura) ----------
function temaAtual() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function definirTema(t) {
  document.documentElement.setAttribute('data-theme', t);
  store(TEMA_KEY, t);
  render();
}

// ---------- Acesso (servidor Google Apps Script) ----------
// Login, sessão e senhas ficam no servidor (apps-script\Codigo.gs). O servidor só entrega as abas
// das obras liberadas para o usuário; o filtro abaixo é só uma segunda camada na tela.
const SESSAO_KEY = 'cosampa-sessao-google';
let usuario = null;   // { usuario, nome, perfil, obras, trocar }
let token = null;
let manterSessao = false;
const normNome = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
const ehAdmin = () => !!usuario && usuario.perfil === 'admin';
function podeVer(nomeObra) {
  if (!usuario) return false;
  if (usuario.obras === '*') return true;
  return (usuario.obras || []).some(n => normNome(n) === normNome(nomeObra));
}
function aplicarAcesso() {
  data = dataCompleta && usuario ? { ...dataCompleta, obras: dataCompleta.obras.filter(o => podeVer(o.nome)) } : null;
  if (data && !data.obras.length) data = null;
  if (data && ui.obra >= data.obras.length) ui.obra = 0;
}

// Chamada ao servidor. text/plain evita a verificação extra (CORS) que o Apps Script não responde.
async function api(acao, dados = {}) {
  if (!API_URL) throw new Error('O endereço do servidor não foi configurado (API_URL em config.js).');
  let r;
  try {
    r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ acao, token, ...dados }) });
  } catch (e) { const er = new Error('Sem conexão com o servidor. Verifique a internet.'); er.rede = true; throw er; }
  let j;
  try { j = await r.json(); } catch (e) { throw new Error(`Resposta inválida do servidor (${r.status}).`); }
  if (!j.ok) { const er = new Error(j.erro || 'Erro no servidor.'); er.sessao = j.sessao === 'expirada'; throw er; }
  return j;
}

function sessaoSalva() {
  for (const st of [sessionStorage, localStorage]) {
    try { const s = JSON.parse(st.getItem(SESSAO_KEY)); if (s && s.token && s.usuario) return { ...s, manter: st === localStorage }; }
    catch (e) { /* sessão inválida */ }
  }
  return null;
}
function guardarSessao(t, u, manter) {
  apagarSessao();
  try { (manter ? localStorage : sessionStorage).setItem(SESSAO_KEY, JSON.stringify({ token: t, usuario: u })); } catch (e) { /* armazenamento indisponível */ }
}
function apagarSessao() {
  for (const st of [sessionStorage, localStorage]) { try { st.removeItem(SESSAO_KEY); } catch (e) { /* ignora */ } }
}
// Dados guardados no aparelho são só do usuário que saiu: apaga ao sair ou quando a sessão termina.
function limparAparelho() {
  apagarSessao();
  try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignora */ }
  token = null; usuario = null; data = dataCompleta = null;
  sync = { estado: 'ok', ultima: 0, erro: '' };
}

const telasLogin = ['#loginForm', '#trocaForm', '#esqueciForm', '#senhaLinkForm'];
function mostrarTela(id) {
  document.body.classList.add('sem-login');
  document.body.classList.remove('perfil-usuario');
  $('#login').hidden = false;
  telasLogin.forEach(s => { $(s).hidden = s !== id; });
  $(id).querySelectorAll('.login-erro, .login-ok').forEach(p => { p.hidden = true; });
  const campo = $(id).querySelector('input:not([hidden])');
  if (campo) campo.focus();
}
function mostrarLogin(aviso) {
  mostrarTela('#loginForm');
  $('#loginAviso').textContent = aviso || '';
  $('#loginAviso').hidden = !aviso;
}
function erroEm(sel, msg) { const p = $(sel); p.textContent = msg; p.hidden = false; }
async function comBotao(form, fn) {
  const b = form.querySelector('button[type="submit"]');
  b.disabled = true; b.setAttribute('aria-busy', 'true');
  try { await fn(); } finally { b.disabled = false; b.removeAttribute('aria-busy'); }
}
function erroSenhaNova(senha, senha2) {
  if (senha.length < 6) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (senha !== senha2) return 'As duas senhas não são iguais.';
  return '';
}

async function entrar(e) {
  e.preventDefault();
  await comBotao($('#loginForm'), async () => {
    try {
      manterSessao = $('#loginManter').checked;
      const j = await api('entrar', { usuario: $('#loginUsuario').value.trim(), senha: $('#loginSenha').value, manter: manterSessao });
      $('#loginSenha').value = '';
      token = j.token;
      if (j.usuario.trocar) { pedirTroca(j.usuario); return; }
      guardarSessao(j.token, j.usuario, manterSessao);
      iniciarSessao(j.usuario);
    } catch (err) { erroEm('#loginErro', err.message); $('#loginSenha').select(); }
  });
}
// Entrou com senha provisória: cria a própria antes de ver os dados.
let trocaPendente = null;
function pedirTroca(u) {
  trocaPendente = u;
  mostrarTela('#trocaForm');
  $('#trocaNome').textContent = u.nome;
  $('#trocaUsuario').value = u.usuario;
}
async function salvarTroca(e) {
  e.preventDefault();
  const senha = $('#trocaSenha').value, msg = erroSenhaNova(senha, $('#trocaSenha2').value);
  if (msg) return erroEm('#trocaErro', msg);
  await comBotao($('#trocaForm'), async () => {
    try {
      const j = await api('trocarSenha', { nova: senha, manter: manterSessao });
      $('#trocaForm').reset();
      token = j.token;
      guardarSessao(j.token, j.usuario, manterSessao);
      iniciarSessao(j.usuario);
      toast('Senha criada. Use a nova senha nos próximos acessos.');
    } catch (err) { if (err.sessao) mostrarLogin(err.message); else erroEm('#trocaErro', err.message); }
  });
}
async function pedirLink(e) {
  e.preventDefault();
  await comBotao($('#esqueciForm'), async () => {
    $('#esqueciErro').hidden = $('#esqueciOk').hidden = true;
    try {
      const j = await api('esqueci', { usuario: $('#esqueciUsuario').value.trim() });
      $('#esqueciOk').textContent = j.mensagem; $('#esqueciOk').hidden = false;
    } catch (err) { erroEm('#esqueciErro', err.message); }
  });
}
// Link do e-mail (#/senha/CÓDIGO): convite ou "esqueci minha senha"
let codigoLink = null;
async function salvarSenhaLink(e) {
  e.preventDefault();
  const senha = $('#linkSenha').value, msg = erroSenhaNova(senha, $('#linkSenha2').value);
  if (msg) return erroEm('#linkErro', msg);
  await comBotao($('#senhaLinkForm'), async () => {
    try {
      const j = await api('redefinir', { codigo: codigoLink, nova: senha });
      codigoLink = null;
      $('#senhaLinkForm').reset();
      token = j.token; manterSessao = false;
      guardarSessao(j.token, j.usuario, false);
      iniciarSessao(j.usuario);
      toast('Senha criada. Bem-vindo!');
    } catch (err) { erroEm('#linkErro', err.message); }
  });
}
// Configurações → Minha senha
async function alterarMinhaSenha(e) {
  e.preventDefault();
  const senha = $('#senhaNova').value, msg = erroSenhaNova(senha, $('#senhaNova2').value);
  $('#minhaSenhaErro').hidden = true;
  if (msg) return erroEm('#minhaSenhaErro', msg);
  await comBotao($('#minhaSenhaForm'), async () => {
    try {
      const j = await api('trocarSenha', { atual: $('#senhaAtual').value, nova: senha, manter: manterSessao });
      token = j.token;
      guardarSessao(j.token, j.usuario, manterSessao);
      $('#minhaSenhaForm').reset();
      toast('Senha alterada. Os outros aparelhos conectados vão pedir login de novo.');
    } catch (err) { if (err.sessao) sessaoTerminou(err.message); else erroEm('#minhaSenhaErro', err.message); }
  });
}

function iniciarSessao(u) {
  usuario = u;
  aplicarAcesso();
  $('#login').hidden = true;
  document.body.classList.remove('sem-login');
  render();
  sincronizar();
}
function sair() {
  if (token) api('sair').catch(() => {});
  limparAparelho();
  ui = { tab: 'geral', modo: 'total', obra: 0, f: {}, de: null, ate: '' };
  history.replaceState({ d: 0 }, '', hashDe(ui));
  fecharMenu();
  mostrarLogin();
}
function sessaoTerminou(msg) {
  limparAparelho();
  mostrarLogin(msg || 'Sua sessão terminou. Entre de novo.');
}
function renderUsuario() {
  if (!usuario) return;
  document.body.classList.toggle('perfil-usuario', !ehAdmin());
  $('#usuarioNome').textContent = usuario.nome;
  $('#minhaSenhaUsuario').value = usuario.usuario; // ajuda o gerenciador de senhas do navegador
  $('#usuarioIni').textContent = usuario.nome.trim().charAt(0).toUpperCase();
  $('#usuarioPerfil').textContent = usuario.obras === '*' ? (ehAdmin() ? 'Administrador · todas as obras' : 'Todas as obras') : usuario.obras.join(', ');
}

// ---------- Configurações → Usuários (só admin, direto no servidor) ----------
let usuariosSrv = [], editando = null, usuariosCarregadosEm = 0;
const usuarioDeNome = nome => normNome(nome).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
async function carregarUsuarios(forcar) {
  if (!ehAdmin() || (!forcar && Date.now() - usuariosCarregadosEm < 60000)) return renderUsuarios();
  try {
    usuariosSrv = (await api('usuarios')).usuarios;
    usuariosCarregadosEm = Date.now();
  } catch (err) {
    if (err.sessao) return sessaoTerminou(err.message);
    $('#usuLista').innerHTML = `<p class="login-erro">${esc(err.message)}</p>`;
    return;
  }
  renderUsuarios();
}
function renderUsuarios() {
  if (!ehAdmin()) return;
  const quando = iso => (iso ? 'último acesso ' + dataHora(iso) : 'nunca entrou');
  $('#usuLista').innerHTML = usuariosSrv.length ? usuariosSrv.map(u => `<div class="usu-item${u.ativo ? '' : ' inativo'}">
      <span class="usu-info"><b>${esc(u.nome)}</b><small>${esc(u.usuario)} · ${esc(u.email || 'sem e-mail')} · ${u.perfil === 'admin' ? 'administrador (todas as obras)' : esc(u.obras.join(', '))}</small>
        <small>${u.ativo ? '' : '<em>bloqueado</em> · '}${u.temSenha ? (u.trocar ? 'senha provisória' : 'senha criada') : '<em>aguardando criar a senha</em>'} · ${quando(u.ultimoAcesso)}</small></span>
      <span class="usu-acoes"><button class="btn" type="button" data-editar="${esc(u.usuario)}">Alterar</button>${u.ativo ? `<button class="btn" type="button" data-convite="${esc(u.usuario)}">Copiar link de convite</button>` : ''}${u.email ? `<button class="btn" type="button" data-link="${esc(u.usuario)}">Enviar link por e-mail</button>` : ''}${u.usuario === usuario.usuario ? '' : `<button class="btn perigo" type="button" data-remover="${esc(u.usuario)}">Remover</button>`}</span>
    </div>`).join('') : '<p class="muted small">Nenhum usuário.</p>';
  const nomes = dataCompleta ? dataCompleta.obras.map(o => o.nome) : [];
  const grade = $('#novoObras');
  if (grade.dataset.obras !== nomes.join('|')) {
    const marcadas = [...grade.querySelectorAll('input:checked')].map(c => c.value);
    grade.dataset.obras = nomes.join('|');
    grade.innerHTML = nomes.map(n => `<label class="chk"><input type="checkbox" value="${esc(n)}"${marcadas.includes(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('');
  }
  grade.querySelectorAll('input').forEach(c => { c.disabled = $('#novoAdmin').checked; });
  $('#campoProvisoria').hidden = modoSenha() !== 'provisoria';
}
const modoSenha = () => ($('#usuForm').querySelector('input[name="modoSenha"]:checked') || {}).value;
function limparFormUsuario() {
  editando = null;
  $('#usuForm').reset();
  $('#novoUsuario').dataset.manual = '';
  $('#usuFormTit').textContent = 'Novo usuário';
  $('#usuSalvar').textContent = 'Adicionar usuário';
  $('#rotConvite').textContent = 'Enviar convite por e-mail para ele criar a senha';
  $('#rotLink').textContent = 'Gerar link de convite para eu enviar (WhatsApp, Teams…)';
  $('#usuCancelar').hidden = $('#optManter').hidden = $('#optAtivo').hidden = true;
  $('#usuErro').hidden = true;
  renderUsuarios();
}
function editarUsuario(nome) {
  const u = usuariosSrv.find(x => x.usuario === nome); if (!u) return;
  limparFormUsuario();
  editando = u.usuario;
  $('#novoNome').value = u.nome; $('#novoEmail').value = u.email; $('#novoUsuario').value = u.usuario;
  $('#novoUsuario').dataset.manual = '1';
  $('#novoAdmin').checked = u.perfil === 'admin';
  $('#novoAtivo').checked = u.ativo;
  renderUsuarios();
  $('#novoObras').querySelectorAll('input').forEach(c => { c.checked = u.obras !== '*' && u.obras.some(n => normNome(n) === normNome(c.value)); });
  $('#optManter').hidden = $('#optAtivo').hidden = false;
  $('#optManter').querySelector('input').checked = true;
  $('#rotConvite').textContent = 'Enviar e-mail com link para ele criar uma nova senha';
  $('#rotLink').textContent = 'Gerar link para ele criar uma nova senha (eu envio por WhatsApp, Teams…)';
  $('#usuFormTit').textContent = `Alterar ${u.nome}`;
  $('#usuSalvar').textContent = 'Salvar alterações';
  $('#usuCancelar').hidden = false;
  renderUsuarios();
  $('#usuForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function salvarUsuario(e) {
  e.preventDefault();
  $('#usuErro').hidden = true;
  const modo = modoSenha();
  const dados = {
    original: editando || undefined,
    nome: $('#novoNome').value.trim(),
    email: $('#novoEmail').value.trim(),
    usuario: $('#novoUsuario').value.trim().toLowerCase(),
    perfil: $('#novoAdmin').checked ? 'admin' : 'usuario',
    obras: [...$('#novoObras').querySelectorAll('input:checked')].map(c => c.value),
    ativo: editando ? $('#novoAtivo').checked : true,
    enviarConvite: modo === 'convite',
    gerarLink: modo === 'link',
    senhaProvisoria: modo === 'provisoria' ? $('#novaSenha').value : undefined
  };
  if (modo === 'provisoria' && dados.senhaProvisoria.length < 6) return erroEm('#usuErro', 'A senha provisória precisa ter pelo menos 6 caracteres.');
  if (modo === 'convite' && !dados.email) return erroEm('#usuErro', 'Para enviar o convite por e-mail, preencha o e-mail. Ou escolha "Gerar link de convite".');
  if (dados.perfil !== 'admin' && !dados.obras.length) return erroEm('#usuErro', 'Marque pelo menos uma obra, ou Administrador.');
  await comBotao($('#usuForm'), async () => {
    try {
      const j = await api('salvarUsuario', { dados });
      toast(j.mensagem);
      limparFormUsuario();
      carregarUsuarios(true);
      if (j.link) mostrarLinkConvite(j);
    } catch (err) { if (err.sessao) sessaoTerminou(err.message); else erroEm('#usuErro', err.message); }
  });
}
// Link de convite para o admin mandar por WhatsApp/Teams: mensagem pronta para copiar
function mostrarLinkConvite(j) {
  const u = j.usuario, nome = u.nome.trim().split(/\s+/)[0];
  const app = location.origin + location.pathname;
  $('#linkTit').textContent = `Link de convite: ${u.nome}`;
  $('#linkInfo').textContent = `Vale por ${j.prazo} e só pode ser usado uma vez. Copie e envie para ${nome}.`;
  $('#linkMsg').value = `Olá, ${nome}! Seu acesso ao Controle de Faturamento COSAMPA está pronto.\n\n` +
    `1. Abra este link (vale por ${j.prazo}) e crie a sua senha:\n${j.link}\n\n` +
    `2. Depois, para entrar, use o endereço ${app}\nUsuário: ${u.usuario}`;
  $('#linkMsg').dataset.link = j.link;
  $('#linkDlg').showModal();
}
async function copiarTexto(txt, msg) {
  try { await navigator.clipboard.writeText(txt); toast(msg); }
  catch (e) { $('#linkMsg').select(); toast('Selecionei o texto: aperte Ctrl + C para copiar.'); }
}
async function linkConvite(nome) {
  const u = usuariosSrv.find(x => x.usuario === nome); if (!u) return;
  if (u.temSenha && !u.trocar && !confirm(`${u.nome} já criou a senha. Gerar um link para ele criar uma NOVA senha?`)) return;
  try { mostrarLinkConvite(await api('linkConvite', { usuario: u.usuario })); }
  catch (err) { if (err.sessao) sessaoTerminou(err.message); else toast(err.message); }
}
async function acaoUsuario(acao, nome) {
  const u = usuariosSrv.find(x => x.usuario === nome); if (!u) return;
  if (acao === 'removerUsuario' && !confirm(`Remover ${u.nome} (${u.usuario})? Ele perde o acesso na hora.`)) return;
  if (acao === 'enviarLink' && !confirm(`Enviar para ${u.email} um link para criar uma nova senha?`)) return;
  try {
    const j = await api(acao, { usuario: u.usuario });
    toast(j.mensagem);
    if (acao === 'removerUsuario' && editando === u.usuario) limparFormUsuario();
    carregarUsuarios(true);
  } catch (err) { if (err.sessao) sessaoTerminou(err.message); else toast(err.message); }
}

// ---------- Importação ----------
function carregar(sheets, nome, origem) {
  const novo = MODEL.build(sheets, nome);
  novo.origem = origem;
  const mudou = !dataCompleta || JSON.stringify(novo.obras) !== JSON.stringify(dataCompleta.obras);
  dataCompleta = novo;
  store(STORE_KEY, dataCompleta);
  aplicarAcesso();
  render();
  return mudou;
}
async function importar(file) {
  toast('Nesta versão os dados vêm do servidor; não é preciso importar arquivo.'); return;
  try {
    const sheets = await XLSX_MIN.read(await file.arrayBuffer());
    carregar(sheets, file.name, 'arquivo');
    toast(`Planilha importada: ${data.obras.length} obras, ${data.obras.reduce((n, o) => n + o.medicoes.length, 0)} lançamentos.`);
  } catch (e) {
    console.error(e);
    toast('Não foi possível ler o arquivo: ' + e.message);
  }
}

// ---------- Atualização automática pelo link publicado ----------
function fonteSalva() { const v = loadTxt(FONTE_KEY); return v === null ? FONTE_PADRAO : v; }
// Aceita o link de "Publicar na Web" (pubhtml) ou o link normal da planilha e devolve o endereço do .xlsx.
function urlXlsx(u) {
  u = (u || '').trim();
  if (!u) return '';
  const pub = /docs\.google\.com\/spreadsheets\/d\/e\/([^/?#]+)/.exec(u);
  if (pub) return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=xlsx`;
  const ed = /docs\.google\.com\/spreadsheets\/d\/([^/?#]+)/.exec(u);
  if (ed) return `https://docs.google.com/spreadsheets/d/${ed[1]}/export?format=xlsx`;
  return u;
}
// Aberto direto do disco (file://), o navegador bloqueia a leitura do link; funciona pelo atalho .bat ou publicado.
const EM_ARQUIVO = location.protocol === 'file:';
const linkAtivo = () => !!API_URL;
let sync = { estado: 'ok', ultima: 0, erro: '' };
async function sincronizar({ manual = false } = {}) {
  if (!token || !usuario || sync.estado === 'sinc') return;
  const tinha = !!dataCompleta;
  sync.estado = 'sinc'; estadoPlanilha();
  try {
    const j = await api('dados');
    // O servidor manda o perfil atualizado (obras liberadas podem ter mudado)
    if (j.usuario) { usuario = j.usuario; guardarSessao(token, usuario, manterSessao); }
    let mudou = false;
    if (j.sheets && j.sheets.length) mudou = carregar(j.sheets, j.arquivo || 'Planilha de faturamento', 'link');
    else { mudou = tinha; dataCompleta = null; try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignora */ } aplicarAcesso(); render(); }
    sync = { estado: 'ok', ultima: Date.now(), erro: '' };
    if (manual) toast(mudou ? 'Dados atualizados.' : 'Dados em dia: nenhuma mudança.');
    else if (mudou && tinha) toast('Dados atualizados com a planilha.');
  } catch (e) {
    if (e.sessao) { sync.estado = 'ok'; sessaoTerminou(e.message); return; }
    console.error(e);
    sync.estado = 'erro'; sync.erro = e.message;
    if (manual || !dataCompleta) toast(`Não foi possível buscar os dados (${e.message}). ${dataCompleta ? 'Mostrando os dados guardados.' : ''}`);
  }
  estadoPlanilha();
  if (!data) render();
}
function dataHora(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}
function fonteTexto() {
  return data ? `${data.arquivo} · ${data.origem === 'link' ? 'lida' : 'importado'} em ${dataHora(data.importadoEm)}` : '';
}

// ---------- Cálculos ----------
function numeros(o, modo) {
  const k = modo === 'cosampa' ? (o.share ?? 0) : 1;
  const contrato = (o.contrato || 0) * k, medido = (o.medido || 0) * k, faturado = (o.faturado || 0) * k, recebido = (o.recebido || 0) * k;
  const aReceber = o.falta != null ? o.falta * k : medido - recebido; // "Falta receber" da aba (CCAC: medido − faturado)
  return { contrato, medido, faturado, recebido, aReceber, aMedir: contrato - medido };
}
// ---------- Posição até um mês (filtro de período da visão geral) ----------
// Lançamentos só com o ano (ex.: "2024") contam como dezembro daquele ano.
const ymFim = ym => (ym % 100 ? ym : ym + 12);
const mesLabel = ym => `${MODEL.MES_NOME[ym % 100]}/${Math.floor(ym / 100)}`;
const ymDe = x => x.ymPos || x.ym; // mês da posição (BM sem data herda do vizinho; ver model.js)
const ateMes = (x, ate) => !!ymDe(x) && ymFim(ymDe(x)) <= ate;
function mesesDisponiveis(obras = data.obras) {
  const s = new Set();
  for (const o of obras) for (const x of o.series) if (ymDe(x) && (x.med || x.fat || x.rec)) s.add(ymFim(ymDe(x)));
  return [...s].sort((a, b) => b - a);
}
// Sem mês: usa o resumo REALIZADO/SALDO da aba. Com mês: soma, até aquele mês, quanto cada BM entra
// nas fórmulas do resumo (a mesma regra da aba, lida pelo model.js).
function numerosAte(o, modo, ate) {
  if (!ate) return numeros(o, modo);
  const k = modo === 'cosampa' ? (o.share ?? 0) : 1;
  const soma = key => o.series.reduce((a, x) => a + (ateMes(x, ate) ? (x[key] || 0) : 0), 0);
  const contrato = (o.contrato || 0) * k, medido = soma('med') * k, faturado = soma('fat') * k, recebido = soma('rec') * k;
  // Recebido a mais (ajuste só no recebimento) não vira "a receber" negativo: fica zero até o próximo BM.
  const aReceber = Math.max(0, o.resumoCol && o.resumoCol.falta ? soma('fal') * k : medido - recebido);
  return { contrato, medido, faturado, recebido, aReceber, aMedir: contrato - medido };
}
function somar(obras, modo, ate) {
  const t = { contrato: 0, medido: 0, faturado: 0, recebido: 0, aReceber: 0, aMedir: 0 };
  for (const o of obras) { const n = numerosAte(o, modo, ate); for (const k in t) t[k] += n[k]; }
  return t;
}
// Valor grande abreviado (R$ 1,84 bi); o exato fica embaixo. Barrinha = % do contrato.
function tile(k, v, d, frac, cor) {
  const bar = frac != null && isFinite(frac) ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, frac * 100))}%"></i></div>` : '';
  return `<div class="tile"${cor ? ` style="--cor:${cor}"` : ''}><div class="k">${k}</div><div class="v" title="${brl(v)}">R$ ${compact(v)}</div><div class="d">${d ? d + '<br>' : ''}${brl(v)}</div>${bar}</div>`;
}
function tiles(n) {
  const f = x => (n.contrato ? x / n.contrato : null);
  return [
    tile('Valor de contrato', n.contrato, '', null, 'var(--laranja)'),
    tile('Medido', n.medido, pct(n.medido, n.contrato) + ' do contrato', f(n.medido), 'var(--s1)'),
    tile('Faturado', n.faturado, pct(n.faturado, n.contrato) + ' do contrato', f(n.faturado), 'var(--s2)'),
    tile('Recebido', n.recebido, pct(n.recebido, n.contrato) + ' do contrato', f(n.recebido), 'var(--s3)'),
    tile('A receber', n.aReceber, 'medido − recebido', f(n.aReceber), 'var(--warning)'),
    tile('Saldo a medir', n.aMedir, pct(n.aMedir, n.contrato) + ' do contrato', f(n.aMedir), 'var(--neutro)')
  ].join('');
}
// Se a planilha registra mais recebido que faturado (erro de digitação), o "faturado a receber" fica em zero
// e o "medido a faturar" passa a contar a partir do recebido; a soma das partes continua igual ao contrato.
function compos(n) {
  const fat = Math.max(n.faturado, n.recebido);
  return [
    { ...COMPOS[0], v: n.recebido },
    { ...COMPOS[1], v: fat - n.recebido },
    { ...COMPOS[2], v: n.medido - fat },
    { ...COMPOS[3], v: n.aMedir }
  ];
}

// ---------- Prazos e previsões (seção discreta, recolhida por padrão) ----------
// A planilha só tem o mês do BM; os dias são contados a partir do último dia desse mês.
function diasDesde(ym) {
  const f = ymFim(ym), fim = new Date(Math.floor(f / 100), f % 100, 0);
  return Math.max(0, Math.floor((Date.now() - fim) / 86400000));
}
function renderPrazos(el, obras, umaObra) {
  const fat = [];
  for (const o of obras) {
    const ix = {};
    for (const m of o.medicoes) {
      if (m.status !== 'Faturada') continue;
      const g = ix[m.bm] || (ix[m.bm] = { obra: o.nome, bm: m.bm, mes: m.mes, ym: m.ym, v: 0 });
      g.v += m.total;
    }
    fat.push(...Object.values(ix));
  }
  fat.forEach(g => { g.dias = g.ym ? diasDesde(g.ym) : null; });
  fat.sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1));
  const prev = obras.flatMap(o => (o.previsoes || []).map(p => ({ ...p, obra: o.nome })));
  if (!fat.length && !prev.length) { el.hidden = true; return; }
  el.hidden = false;
  const nome = x => (umaObra ? '' : esc(x.obra) + ' · ');
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  const lFat = fat.length ? fat.map(g => `<li><span>${nome(g)}${esc(g.bm)}${g.mes ? ` (${esc(g.mes)})` : ''}</span><span>R$ ${compact(g.v)}${g.dias != null ? ` · <span class="dias${g.dias > 30 ? ' longo' : ''}">~${g.dias} dias</span>` : ''}</span></li>`).join('')
    : '<li><span class="dias">Nenhum BM faturado aguardando recebimento.</span></li>';
  const lPrev = prev.length ? prev.map(p => `<li title="Fonte: ${esc(p.fonte)}"><span>${nome(p)}${esc(p.bm)}${p.mes ? ` (${esc(p.mes)})` : ''}</span><span>R$ ${compact(p.v)}</span></li>`).join('')
    : '<li><span class="dias">Nenhuma previsão informada.</span></li>';
  el.innerHTML = `<summary><b>Prazos e previsões</b><span class="resumo">${plural(fat.length, 'BM faturado aguardando recebimento', 'BMs faturados aguardando recebimento')} · ${plural(prev.length, 'previsão de medição', 'previsões de medição')}</span></summary>
    <div class="corpo"><div><h4>Faturado aguardando recebimento</h4><ul>${lFat}</ul></div>
    <div><h4>Previsão de medição</h4><ul>${lPrev}</ul></div>
    <p class="nota">Dias contados a partir do fim do mês do BM (a planilha não tem a data da nota fiscal). Previsões vêm da linha "Previsão medição" ou de BMs comentados como previstos na planilha.</p></div>`;
  el.open = !!ui.prazosAberto;
  el.ontoggle = () => { ui.prazosAberto = el.open; store(UI_KEY, ui); };
}

// ---------- Visão geral ----------
function renderGeral(root, opts = {}) {
  const modo = opts.modo || ui.modo;
  const meses = mesesDisponiveis();
  const ate = opts.print ? 0 : (meses.includes(+ui.ate) ? +ui.ate : 0);
  root.querySelectorAll('[data-r="modo"] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
  const sel = R(root, 'ate');
  sel.innerHTML = '<option value="">Atual (resumo da planilha)</option>' + meses.map(m => `<option value="${m}"${m === ate ? ' selected' : ''}>até ${mesLabel(m)}</option>`).join('');
  sel.classList.toggle('ativo', !!ate);
  const obras = modo === 'cosampa' ? data.obras.filter(o => o.share != null) : data.obras;
  const fora = data.obras.filter(o => o.share == null).map(o => o.nome);
  const notas = [modo === 'cosampa'
    ? `Valores × participação COSAMPA.${fora.length ? ' Fora do total (sem % na planilha): ' + fora.join(', ') + '.' : ''}`
    : 'Valores do contrato inteiro (100%).'];
  notas.push(ate
    ? `Posição até ${mesLabel(ate)}: fórmulas do resumo de cada aba, somando só os BMs até esse mês.`
    : 'Posição atual, conforme o resumo REALIZADO/SALDO de cada aba.');
  R(root, 'nota').textContent = notas.join(' ');
  R(root, 'notaPrint').textContent = notas.join(' ');
  const t = somar(obras, modo, ate);
  R(root, 'tiles').innerHTML = tiles(t);

  const w = opts.print ? { width: 300, animate: false } : {};
  const chave = `${modo}-${ate}`;
  CHARTS.donut(R(root, 'donut'), compos(t), { key: 'donut-' + chave, centroValor: pct(t.recebido, t.contrato), centroRotulo: 'recebido', aria: 'Composição do contrato', ...w });

  const rows = obras.map(o => {
    const n = numerosAte(o, modo, ate);
    return { label: o.nome, idx: data.obras.indexOf(o), right: `${compact(n.contrato)} · ${pct(n.recebido, n.contrato)} recebido`, segs: compos(n), base: n.contrato };
  });
  CHARTS.stackBars(R(root, 'obras'), rows, COMPOS, {
    key: 'obras-' + chave, aria: 'Execução financeira por obra',
    onClick: opts.print ? null : r => navegar({ tab: 'obra', obra: r.idx }),
    ...(opts.print ? { width: 420, animate: false } : {})
  });

  // no PDF o "R$" de cada célula some (o cabeçalho avisa) para as 10 colunas caberem na folha
  const v = x => brl(x).replace(/R\$\s/, '<span class="rs">R$ </span>');
  const head = `<thead><tr><th>Obra<span class="print-only">valores em R$</span></th><th class="n">Part.</th><th>Posição</th><th class="n">Contrato</th><th class="n">Medido</th><th class="n">% med.</th><th class="n">Faturado</th><th class="n">Recebido</th><th class="n">A receber</th><th class="n">Saldo a medir</th></tr></thead>`;
  const body = obras.map(o => {
    const n = numerosAte(o, modo, ate);
    return `<tr class="clicavel" data-obra="${data.obras.indexOf(o)}"><td><div class="obra-cel"><div><b>${esc(o.nome)}</b>
      <small>${o.medicoes.length} lançamentos</small></div></div></td>
      <td class="n">${o.share != null ? (o.share * 100).toLocaleString('pt-BR') + '%' : '—'}</td><td>${ate ? 'até ' + mesLabel(ate) : o.refMes ? 'até BM de ' + esc(o.refMes) : '—'}</td>
      <td class="n">${v(n.contrato)}</td><td class="n">${v(n.medido)}</td><td class="n">${pct(n.medido, n.contrato)}</td>
      <td class="n">${v(n.faturado)}</td><td class="n">${v(n.recebido)}</td><td class="n">${v(n.aReceber)}</td><td class="n">${v(n.aMedir)}</td></tr>`;
  }).join('');
  const foot = `<tfoot><tr><td>Total</td><td></td><td></td><td class="n">${v(t.contrato)}</td><td class="n">${v(t.medido)}</td><td class="n">${pct(t.medido, t.contrato)}</td><td class="n">${v(t.faturado)}</td><td class="n">${v(t.recebido)}</td><td class="n">${v(t.aReceber)}</td><td class="n">${v(t.aMedir)}</td></tr></tfoot>`;
  R(root, 'tabela').innerHTML = head + '<tbody>' + body + '</tbody>' + foot;
  renderPrazos(R(root, 'prazos'), data.obras, false);
}

// ---------- Por obra ----------
function bmShort(label) {
  if (/^downpayment/i.test(label)) return 'DP';
  const r = /BM\s*0*(\d+)\s*a\s*0*(\d+)/i.exec(label);
  if (r) return `${r[1]}–${r[2]}`;
  const m = /BM\s*0*(\d+)/i.exec(label);
  return m ? m[1] : label;
}

function renderObra(root, idx, opts = {}) {
  const o = data.obras[idx] || data.obras[0];
  const pw = opts.print ? { width: 720, animate: false } : {};
  R(root, 'chips').innerHTML = data.obras.map((x, i) => `<button data-obra="${i}" aria-pressed="${i === idx}">${esc(x.nome)}</button>`).join('');
  R(root, 'titulo').textContent = o.nome;
  R(root, 'info').textContent = [
    o.share != null ? `Participação COSAMPA: ${(o.share * 100).toLocaleString('pt-BR')}%` : 'Participação COSAMPA não informada',
    o.refMes ? `posição até o BM de ${o.refMes}` : null,
    `${o.medicoes.length} lançamentos`,
    o.previsao ? `${o.previsao.texto}: ${brl(o.previsao.v)}` : null
  ].filter(Boolean).join(' · ');
  let t = tiles(numeros(o, 'total'));
  if (o.share != null) {
    const c = numeros(o, 'cosampa');
    t += tile('Parte COSAMPA a receber', c.aReceber, `recebido R$ ${compact(c.recebido)}`, null, 'var(--laranja)');
  }
  R(root, 'tiles').innerHTML = t;

  // Colunas por BM, empilhadas pela situação
  const groups = [], ix = {};
  for (const m of o.medicoes) {
    let g = ix[m.bm];
    if (!g) { g = ix[m.bm] = { label: m.bm, short: bmShort(m.bm), sub: m.mes, v: {}, linhas: [] }; groups.push(g); }
    g.v[m.status] = (g.v[m.status] || 0) + m.total;
    g.linhas.push(m);
  }
  for (const g of groups) g.extra = '<div class="muted" style="margin-top:4px">' + g.linhas.map(l => `${esc(l.tipo)}: ${brl(l.total)}`).join('<br>') + '</div>';
  CHARTS.columns(R(root, 'bm'), groups, STATUS, {
    key: 'bm-' + o.nome, aria: `Faturamento por BM — ${o.nome}`, ...pw,
    onClick: opts.print ? null : g => navegar({ tab: 'medicoes', f: { obra: o.nome, busca: g.label }, de: 'obra', obra: idx })
  });

  // Linhas acumuladas
  // As três linhas vão até o último BM (o da posição do resumo, ex.: "até BM de Outubro") e esse último ponto
  // é o resumo REALIZADO da aba. Faturado/recebido ficam estáveis nos BMs ainda não faturados; o salto no fim
  // é o FD e o desconto de downpayment desses BMs, que o resumo da aba já soma.
  const s = o.series;
  const resumo = { med: o.medido, fat: o.faturado, rec: o.recebido };
  let fim = -1; s.forEach((x, i) => { if (x.med != null || x.fat != null || x.rec != null) fim = i; });
  const acum = key => {
    let acc = 0;
    const v = s.map((x, i) => { if (i > fim) return null; acc += x[key] || 0; return acc; });
    if (fim >= 0 && resumo[key] != null) v[fim] = resumo[key];
    return v;
  };
  CHARTS.lines(R(root, 'acum'), s.map(x => bmShort(x.label)), [
    { key: 'med', name: 'Medido', color: 'var(--s1)', values: acum('med'), width: 2.6 },
    { key: 'fat', name: 'Faturado', color: 'var(--s2)', values: acum('fat'), width: 2.6 },
    { key: 'rec', name: 'Recebido', color: 'var(--s3)', values: acum('rec'), width: 2.6 }
  ], {
    key: 'acum-' + o.nome, ...pw,
    ref: o.contrato ? { value: o.contrato, label: 'Contrato' } : null,
    tipTitle: i => s[i].label + (s[i].mes ? ' · ' + s[i].mes : ''),
    aria: `Acumulado medido, faturado e recebido — ${o.nome}`
  });

  renderPrazos(R(root, 'prazos'), [o], true);

  // Matriz
  const ordem =['previsao', 'medido', 'reajuste', 'aditivo', 'fd', 'desconto', 'faturado', 'reajFat', 'recebido', 'reajRec'];
  const fmt = v => (v == null ? '' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const ncol = o.matrix.cols.length;
  // Coluna Total: sempre com os totais do Resumo de faturamento. Nas linhas da planilha fica vazia, a menos
  // que a soma simples seja ligada em Configurações (ela não segue a fórmula do resumo; ex.: inclui o downpayment).
  const somaLinha = loadTxt(SOMA_LINHA_KEY) === '1';
  let html = '<thead><tr><th>Linha</th>' + o.matrix.cols.map(c => `<th class="n">${esc(c.label)}</th>`).join('') + '<th class="n">Total</th></tr></thead><tbody>';
  for (const k of ordem) {
    const r = o.matrix.rows[k]; if (!r) continue;
    const tot = r.values.reduce((a, v) => a + (v || 0), 0);
    html += `<tr><td>${esc(r.label)}</td>` + r.values.map(v => `<td class="n">${fmt(v)}</td>`).join('') +
      (somaLinha ? `<td class="n soma-linha" title="Soma simples da linha (não é o resumo da aba)">${fmt(tot)}</td>` : '<td></td>') + '</tr>';
  }
  // Resumo REALIZADO: cada coluna mostra quanto ela entra na fórmula da aba. Sem mês, o total é o valor do
  // resumo; com mês (mesma "Posição" da visão geral), soma só os BMs até aquele mês, pela mesma fórmula.
  const rc = o.resumoCol || {}, fr = o.formulaResumo || {}, lr = o.linhasResumo || {};
  const meses = mesesDisponiveis([o]);
  const mesSel = opts.print || !Object.keys(rc).length ? 0 : (meses.includes(+ui.ate) ? +ui.ate : 0);
  const sel = R(root, 'ateMatriz');
  sel.innerHTML = `<option value="">Atual${o.refMes ? ' (até BM de ' + esc(o.refMes) + ')' : ''}</option>` + meses.map(m => `<option value="${m}"${m === mesSel ? ' selected' : ''}>até ${mesLabel(m)}</option>`).join('');
  sel.classList.toggle('ativo', !!mesSel);
  sel.disabled = !Object.keys(rc).length;
  const ate = mesSel ? ` até ${mesLabel(mesSel)}` : o.refMes ? ` até BM de ${o.refMes}` : '';
  const entra = o.matrix.cols.map(c => !mesSel || ateMes(c, mesSel));
  const linhasRes = [['medido', 'Medido'], ['faturado', 'Faturado'], ['recebido', 'Recebido'], ['falta', 'Falta receber']]
    .filter(([k]) => o[k] != null && (!mesSel || rc[k]));
  if (linhasRes.length) {
    html += `</tbody><tbody class="resumo"><tr class="sec"><td colspan="${ncol + 2}"><span>Resumo de faturamento</span></td></tr>`;
    for (const [k, nome] of linhasRes) {
      const dica = fr[k] ? `B${lr[k]} ${fr[k]}` : 'Valor do resumo da aba';
      const vals = rc[k] || Array(ncol).fill(null);
      let tot = mesSel ? vals.reduce((a, v, i) => a + (entra[i] ? v || 0 : 0), 0) : o[k];
      // Recebido maior que o medido até o mês (ajuste lançado só no recebimento): nada falta receber;
      // a sobra fica como crédito e é abatida do próximo BM, como no resumo atual da aba.
      if (k === 'falta' && mesSel && tot < 0) tot = 0;
      html += `<tr title="${esc(dica)}"><td>${nome}${esc(ate)}</td>` + vals.map((v, i) => `<td class="n${entra[i] ? '' : ' fora'}">${fmt(v)}</td>`).join('') + `<td class="n"><b>${fmt(tot)}</b></td></tr>`;
    }
  }
  R(root, 'matriz').innerHTML = html + '</tbody>';
}

// ---------- Medições ----------
function todasMedicoes() { return data.obras.flatMap(o => o.medicoes); }
function filtrar(f = ui.f) {
  const de = f.de ? +f.de.replace('-', '') : null, ate = f.ate ? +f.ate.replace('-', '') : null;
  const q = (f.busca || '').toLowerCase().trim();
  // Lançamentos só com o ano (ex.: "2024") valem de janeiro a dezembro daquele ano.
  const lo = m => (m.ym % 100 ? m.ym : m.ym + 1), hi = m => (m.ym % 100 ? m.ym : m.ym + 12);
  return todasMedicoes().filter(m =>
    (!f.obra || m.obra === f.obra) && (!f.tipo || m.tipo === f.tipo) && (!f.status || m.status === f.status) &&
    (!de || (m.ym && hi(m) >= de)) && (!ate || (m.ym && lo(m) <= ate)) &&
    (!q || `${m.obra} ${m.bm} ${m.mes} ${m.tipo} ${m.status}`.toLowerCase().includes(q)));
}
function fillSelect(sel, values, cur) {
  const first = sel.options[0].outerHTML;
  sel.innerHTML = first + values.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
}
function tabelaMedicoes(rows) {
  const head = '<thead><tr><th>Obra</th><th>Medição</th><th>Mês/Ano</th><th>Tipo</th><th class="n">Fat. bruto</th><th class="n">Fat. direto</th><th class="n">Fat. total</th><th>Situação</th></tr></thead>';
  const body = rows.map(m => `<tr><td>${esc(m.obra)}</td><td>${esc(m.bm)}</td><td>${esc(m.mes)}</td><td>${esc(m.tipo)}</td>
    <td class="n ${m.bruto < 0 ? 'neg' : ''}">${brl(m.bruto)}</td><td class="n">${brl(m.direto)}</td><td class="n ${m.total < 0 ? 'neg' : ''}">${brl(m.total)}</td>
    <td><span class="status st-${esc(m.status)}"><i></i>${esc(m.status)}</span></td></tr>`).join('');
  const tot = rows.reduce((a, m) => a + m.total, 0);
  const foot = `<tfoot><tr><td colspan="4">Total (${rows.length})</td><td class="n">${brl(rows.reduce((a, m) => a + m.bruto, 0))}</td><td class="n">${brl(rows.reduce((a, m) => a + m.direto, 0))}</td><td class="n">${brl(tot)}</td><td></td></tr></tfoot>`;
  return head + '<tbody>' + (body || '<tr><td colspan="8" class="muted">Nenhum lançamento para os filtros escolhidos.</td></tr>') + '</tbody>' + foot;
}
function renderMedicoes() {
  const all = todasMedicoes();
  const uniq = k => [...new Set(all.map(m => m[k]))];
  fillSelect($('#fObra'), data.obras.map(o => o.nome), ui.f.obra);
  fillSelect($('#fTipo'), uniq('tipo').sort(), ui.f.tipo);
  fillSelect($('#fStatus'), STATUS.map(s => s.key).filter(s => uniq('status').includes(s)), ui.f.status);
  $('#fDe').value = ui.f.de || ''; $('#fAte').value = ui.f.ate || '';
  if (document.activeElement !== $('#fBusca')) $('#fBusca').value = ui.f.busca || '';

  const rows = filtrar();
  const soma = fn => rows.filter(fn).reduce((a, m) => a + m.total, 0);
  const tot = soma(() => true);
  $('#tilesFiltro').innerHTML = `<div class="tile"><div class="k">Lançamentos</div><div class="v">${rows.length.toLocaleString('pt-BR')}</div></div>` + [
    tile('Faturamento total', tot, ''),
    tile('Recebido', soma(m => m.status === 'Recebida'), ''),
    tile('Faturado a receber', soma(m => m.status === 'Faturada'), ''),
    tile('Medido a faturar', soma(m => m.status === 'Medida'), '')
  ].join('');
  const f = ui.f, partes = [];
  if (f.obra) partes.push('Obra: ' + f.obra);
  if (f.tipo) partes.push('Tipo: ' + f.tipo);
  if (f.status) partes.push('Situação: ' + f.status);
  if (f.de || f.ate) partes.push(`Período: ${f.de || '…'} a ${f.ate || '…'}`);
  if (f.busca) partes.push('Busca: "' + f.busca + '"');
  $('#filtroTexto').textContent = 'Filtros: ' + (partes.join(' · ') || 'nenhum');
  $('#tabMed').innerHTML = tabelaMedicoes(rows);
}
function exportarCSV() {
  const rows = filtrar();
  const n = v => v.toFixed(2).replace('.', ',');
  const linhas = [['Obra', 'Medição', 'Mês/Ano', 'Tipo', 'Faturamento bruto', 'Faturamento direto', 'Faturamento total', 'Situação'].join(';')]
    .concat(rows.map(m => [m.obra, m.bm, m.mes, m.tipo, n(m.bruto), n(m.direto), n(m.total), m.status].join(';')));
  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  baixar(blob, 'medicoes-filtradas.csv');
}

function baixar(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Excel formatado: cabeçalho escuro, valores em R$, filtro e linha de totais com fórmula.
function exportarXLSX() {
  const rows = filtrar();
  const cab = ['Obra', 'Medição', 'Mês/Ano', 'Tipo', 'Faturamento bruto', 'Faturamento direto', 'Faturamento total', 'Situação'].map(v => ({ v, s: 1 }));
  const dados = rows.map(m => [m.obra, m.bm, m.mes, m.tipo, { v: m.bruto, s: 2 }, { v: m.direto, s: 2 }, { v: m.total, s: 2 }, m.status]);
  const fim = rows.length + 1;
  const total = [{ v: `Total (${rows.length})`, s: 4 }, { v: '', s: 4 }, { v: '', s: 4 }, { v: '', s: 4 },
    ...['E', 'F', 'G'].map(c => ({ f: `SUBTOTAL(9,${c}2:${c}${fim})`, s: 3 })), { v: '', s: 4 }];
  const f = ui.f, filtros = [['Obra', f.obra], ['Tipo', f.tipo], ['Situação', f.status], ['De', f.de], ['Até', f.ate], ['Busca', f.busca]].filter(x => x[1]);
  const info = [
    [{ v: 'Controle de Faturamento — Renováveis e Hídricas', s: 4 }],
    ['Fonte', fonteTexto()],
    ['Exportado em', dataHora(new Date())],
    ['Filtros', filtros.length ? filtros.map(x => `${x[0]}: ${x[1]}`).join(' · ') : 'nenhum'],
    ['Lançamentos', rows.length]
  ];
  const blob = XLSX_MIN.write([
    { nome: 'Medições', larguras: [14, 16, 12, 18, 20, 20, 20, 14], linhas: [cab, ...dados, total], filtro: true, filtroAte: fim, congelar: true },
    { nome: 'Informações', larguras: [16, 90], linhas: info }
  ]);
  const d = new Date(), p = n => String(n).padStart(2, '0');
  baixar(blob, `medicoes-${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}.xlsx`);
}

// ---------- Busca rápida (topo) ----------
const semAcento = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function resultadosBusca(q) {
  const termos = semAcento(q).trim().split(/\s+/).filter(Boolean);
  if (!termos.length || !data) return [];
  const casa = txt => termos.every(t => semAcento(txt).includes(t));
  const res = [];
  data.obras.forEach((o, i) => { if (casa(o.nome)) res.push({ tipo: 'Obra', cls: '', texto: o.nome, info: `${o.medicoes.length} lançamentos`, r: { tab: 'obra', obra: i } }); });
  data.obras.forEach((o, i) => {
    const vistos = new Set();
    for (const m of o.medicoes) {
      if (vistos.has(m.bm)) continue;
      vistos.add(m.bm);
      if (casa(`${o.nome} ${m.bm} ${m.mes} ${m.status}`)) {
        res.push({ tipo: 'BM', cls: 'bm', texto: `${o.nome} · ${m.bm}`, info: `${m.mes} · ${m.status}`, r: { tab: 'medicoes', f: { obra: o.nome, busca: m.bm }, de: 'obra', obra: i } });
      }
    }
  });
  for (const [tab, nome] of [['geral', 'Visão geral'], ['medicoes', 'Medições'], ['config', 'Configurações e avisos']]) {
    if (casa(nome)) res.push({ tipo: 'Página', cls: 'pag', texto: nome, info: '', r: tab === 'medicoes' ? { tab, f: {}, de: null } : { tab } });
  }
  return res.slice(0, 10);
}
let buscaRes = [], buscaSel = 0;
function mostrarBusca() {
  const q = $('#buscaInput').value, lista = $('#buscaLista');
  buscaRes = resultadosBusca(q); buscaSel = 0;
  if (!q.trim()) { lista.hidden = true; return; }
  lista.innerHTML = buscaRes.length
    ? buscaRes.map((x, i) => `<button type="button" role="option" data-i="${i}" class="${i === 0 ? 'sel' : ''}"><span class="tipo ${x.cls}">${x.tipo}</span><span>${esc(x.texto)}</span><small>${esc(x.info)}</small></button>`).join('')
    : `<div class="vazio-b">Nada encontrado para “${esc(q)}”.</div>`;
  lista.hidden = false;
}
function fecharBusca() { $('#buscaLista').hidden = true; $('#busca').classList.remove('aberta'); }
function escolherBusca(i) {
  const x = buscaRes[i]; if (!x) return;
  $('#buscaInput').value = ''; fecharBusca(); $('#buscaInput').blur();
  navegar(x.r);
}

// ---------- Apagar dados do aparelho ----------
function apagarDados() {
  if (!confirm('Apagar a planilha guardada neste aparelho?\n\nA planilha original não é afetada. Se houver link de atualização automática salvo, os dados serão buscados de novo na próxima abertura (para evitar isso, apague o link em Configurações).')) return;
  for (const k of [STORE_KEY, UI_KEY, VISTOS_KEY]) { try { localStorage.removeItem(k); } catch (e) { /* ignora */ } }
  data = dataCompleta = null;
  ui = { tab: 'geral', modo: 'total', obra: 0, f: {}, de: null, ate: '' };
  history.replaceState({ d: 0 }, '', hashDe(ui));
  render();
  toast('Dados apagados deste aparelho.');
}

// ---------- Configurações e avisos ----------
function itensAvisos() {
  const itens = data.obras.flatMap(o => o.alerts.map(a => ({ ...a, obra: o.nome })));
  const ordem = { critico: 0, aviso: 1, info: 2 };
  return itens.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
}
function htmlAlertas() {
  const rot = { critico: 'Crítico', aviso: 'Atenção', info: 'Info' };
  const itens = itensAvisos();
  return itens.length ? itens.map(a =>
    `<div class="alerta ${a.nivel}"><span class="tag">${rot[a.nivel]}</span><div><span class="ob">${esc(a.obra)}</span> — ${esc(a.texto)}</div></div>`).join('')
    : '<p class="muted">Nenhum ponto de atenção encontrado.</p>';
}
// Identifica o conjunto atual de avisos; muda quando a planilha importada traz avisos diferentes.
const assinaturaAvisos = () => (data ? itensAvisos().map(a => a.obra + a.texto).join('|') : '');
function sinalAvisos() {
  const sig = assinaturaAvisos();
  const novo = !!sig && sig !== loadTxt(VISTOS_KEY);
  $('#pontoNovo').hidden = !novo;
  $('#pontoNovoMenu').hidden = !novo;
}
function renderConfig() {
  document.querySelectorAll('#temaSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tema === temaAtual())));
  $('#cfgSomaLinha').checked = loadTxt(SOMA_LINHA_KEY) === '1';
  carregarUsuarios();
  const nL = data.obras.reduce((n, o) => n + o.medicoes.length, 0);
  $('#cfgPlanilha').innerHTML = `Origem: <b>${esc(data.arquivo)}</b>${data.origem === 'link' ? ' (link publicado)' : ''}<br>Lida em ${dataHora(data.importadoEm)}<br>${data.obras.length} obras · ${nL} lançamentos · cópia guardada neste aparelho.`;
  if (document.activeElement !== $('#fonteUrl')) $('#fonteUrl').value = fonteSalva();
  const itens = itensAvisos();
  $('#cfgContagem').textContent = itens.length ? `(${itens.length})` : '';
  $('#listaAlertas').innerHTML = htmlAlertas();
  store(VISTOS_KEY, assinaturaAvisos()); // abriu as configurações = avisos vistos
  sinalAvisos();
}

// ---------- PDF ----------
function nomeArquivoPDF(sufixo) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `Controle de Faturamento - ${sufixo} - ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}
// Rodapé de cada folha: o que é, quando foi gerado e "Página X de Y"
function rodapePDF(rotulo) {
  let s = $('#estiloPagina');
  if (!s) { s = document.createElement('style'); s.id = 'estiloPagina'; document.head.appendChild(s); }
  const txt = `Grupo COSAMPA · ${rotulo} · gerado em ${dataHora(new Date())}`.replace(/["\\]/g, '');
  const fonte = 'font-family: system-ui, "Segoe UI", sans-serif; font-size: 8pt; color: #6b6b73;';
  s.textContent = `@page { @bottom-left { content: "${txt}"; ${fonte} } @bottom-right { content: "Página " counter(page) " de " counter(pages); ${fonte} } }`;
}
function imprimir(titulo, antes, depois) {
  const tituloOriginal = document.title;
  document.title = titulo;
  rodapePDF(titulo.replace(/^Controle de Faturamento - /, '').replace(/ - [\d-]+$/, ''));
  antes && antes();
  const fim = () => { document.title = tituloOriginal; depois && depois(); window.removeEventListener('afterprint', fim); };
  window.addEventListener('afterprint', fim);
  setTimeout(() => window.print(), 60);
}
function pdfTela() {
  const nomes = { geral: 'Visão geral', obra: data.obras[ui.obra]?.nome || 'Obra', medicoes: 'Medições', config: 'Configurações e avisos' };
  imprimir(nomeArquivoPDF(nomes[ui.tab]));
}
// Janela para escolher o que entra no relatório (visão geral e quais obras)
function abrirEscolhaRelatorio() {
  $('#relObras').innerHTML = data.obras.map((o, i) =>
    `<label class="chk"><input type="checkbox" value="${i}" checked> ${esc(o.nome)}</label>`).join('');
  $('#relGeral').checked = true;
  conferirEscolha();
  $('#relDlg').showModal();
}
function escolhaRelatorio() {
  return { geral: $('#relGeral').checked, obras: [...$('#relObras').querySelectorAll('input:checked')].map(c => +c.value) };
}
function conferirEscolha() {
  const e = escolhaRelatorio();
  $('#relGerar').disabled = !e.geral && !e.obras.length;
}
function pdfCompleto(escolha) {
  const e = escolha || { geral: true, obras: data.obras.map((_, i) => i) };
  const todas = e.geral && e.obras.length === data.obras.length;
  const nome = todas ? 'Relatório completo'
    : 'Relatório - ' + [e.geral ? 'Visão geral' : null, ...e.obras.map(i => data.obras[i].nome)].filter(Boolean).join(', ');
  montarRelatorio(e);
  imprimir(nomeArquivoPDF(nome),
    () => document.body.classList.add('imprimindo-relatorio'),
    () => { document.body.classList.remove('imprimindo-relatorio'); $('#relatorio').hidden = true; $('#relatorio').innerHTML = ''; });
}
function montarRelatorio(escolha) {
  const e = escolha || { geral: true, obras: data.obras.map((_, i) => i) };
  const rel = $('#relatorio');
  rel.hidden = false;
  const d = new Date();
  const capa = `<div class="rel-capa"><div><img src="${document.querySelector('.logo-side').src}" alt="Grupo COSAMPA"><h1>Controle de Faturamento — Renováveis e Hídricas</h1>
    <p>Fonte: ${esc(fonteTexto())}</p></div><p>Gerado em ${dataHora(d)}</p></div>`;
  rel.innerHTML = capa;
  const secao = (tplId, titulo) => {
    const s = document.createElement('section');
    s.className = 'rel-secao';
    if (titulo) s.insertAdjacentHTML('beforeend', `<h2>${esc(titulo)}</h2>`);
    const c = $(tplId).cloneNode(true);
    c.removeAttribute('id'); c.hidden = false; c.classList.remove('tab');
    c.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
    s.appendChild(c); rel.appendChild(s);
    return c;
  };
  if (e.geral) for (const modo of ['total', 'cosampa']) {
    const g = secao('#tab-geral', modo === 'total' ? 'Visão geral — contrato 100%' : 'Visão geral — parte COSAMPA');
    renderGeral(g, { print: true, modo });
  }
  e.obras.forEach(i => {
    const o = data.obras[i];
    const c = secao('#tab-obra', '');
    renderObra(c, i, { print: true });
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>Lançamentos — ${esc(o.nome)}</h3><div class="table-wrap"><table>${tabelaMedicoes(o.medicoes)}</table></div>`;
    c.appendChild(card);
  });
}

// ---------- Navegação (com histórico: Voltar do navegador e gesto de voltar do celular) ----------
// Cada tela tem um endereço: #/geral, #/obra/2, #/medicoes?obra=...&busca=..., #/config
function hashDe(r) {
  let h = '#/' + r.tab;
  if (r.tab === 'geral' && r.ate) h += '?ate=' + r.ate;
  if (r.tab === 'obra') h += '/' + (r.obra || 0);
  if (r.tab === 'medicoes') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(r.f || {})) if (v) q.set(k, v);
    if (r.de === 'obra') { q.set('de', 'obra'); q.set('o', r.obra); }
    const s = q.toString();
    if (s) h += '?' + s;
  }
  return h;
}
function lerHash() {
  const m = /^#\/(\w+)(?:\/(\d+))?(?:\?(.*))?$/.exec(location.hash);
  if (!m || !ROTAS.includes(m[1])) return null;
  const r = { tab: m[1], f: {}, de: null };
  if (m[1] === 'obra') r.obra = +(m[2] || 0);
  if (m[1] === 'geral') r.ate = (m[3] && new URLSearchParams(m[3]).get('ate')) || '';
  if (m[1] === 'medicoes' && m[3]) {
    for (const [k, v] of new URLSearchParams(m[3])) {
      if (k === 'de') r.de = v; else if (k === 'o') r.obra = +v; else r.f[k] = v;
    }
  }
  return r;
}
function aplicar(r) {
  ui.tab = r.tab;
  if (r.obra != null) ui.obra = r.obra;
  if (r.ate != null) ui.ate = r.ate;
  if (r.tab === 'medicoes') { ui.f = r.f || {}; ui.de = r.de || null; }
}
const profundidade = () => (history.state && history.state.d) || 0;
function navegar(r, { substituir = false } = {}) {
  aplicar(r);
  const h = hashDe(ui);
  if (substituir) history.replaceState({ d: profundidade() }, '', h);
  else if (h !== location.hash) history.pushState({ d: profundidade() + 1 }, '', h);
  fecharMenu();
  render();
  if (!substituir) window.scrollTo(0, 0);
}
// Caminho até a tela atual (trilha no topo). O último item é a tela aberta.
function trilha() {
  const t = [{ label: 'Visão geral', r: { tab: 'geral' } }];
  const o = data && data.obras[ui.obra];
  if (ui.tab === 'obra' && o) t.push({ label: o.nome });
  else if (ui.tab === 'medicoes') {
    if (ui.de === 'obra' && o) {
      t.push({ label: o.nome, r: { tab: 'obra', obra: ui.obra } });
      t.push({ label: ui.f.busca || 'Medições' });
    } else t.push({ label: 'Medições' });
  } else if (ui.tab === 'config') t.push({ label: 'Configurações' });
  return t;
}
function voltar() {
  const t = trilha();
  if (profundidade() > 0) history.back();
  else if (t.length > 1) navegar(t[t.length - 2].r, { substituir: true });
}
function renderTopo() {
  const t = data ? trilha() : [{ label: 'Controle de Faturamento' }];
  $('#tituloPagina').textContent = t[t.length - 1].label;
  $('#trilha').innerHTML = '<span>Controle de Faturamento</span>' +
    t.slice(0, -1).map((x, i) => `<span class="sep">›</span><a href="${hashDe({ ...ui, ...x.r, f: {} })}" data-i="${i}">${esc(x.label)}</a>`).join('');
  $('#voltar').hidden = t.length < 2;
}

function estadoPlanilha() {
  const temLink = linkAtivo();
  $('#sincronizar').hidden = !temLink;
  $('#importarLado').hidden = temLink;
  $('#sincronizar').setAttribute('aria-busy', String(sync.estado === 'sinc'));
  $('#estadoModo').textContent = temLink ? 'Fonte: servidor Google (acesso por usuário)'
    : EM_ARQUIVO && urlXlsx(fonteSalva()) ? 'Arquivo local: sincronização só pelo atalho .bat' : 'Modo local (este navegador)';
  $('#vazioCarregando').hidden = !(sync.estado === 'sinc' && !dataCompleta);
  const pt = $('#estadoPt'), txt = $('#estadoTxt');
  if (sync.estado === 'sinc') { pt.className = 'pt sinc'; txt.textContent = 'Sincronizando…'; return; }
  if (!dataCompleta) { pt.className = sync.estado === 'erro' ? 'pt erro' : 'pt vazio'; txt.textContent = sync.estado === 'erro' ? 'Sem conexão com a planilha' : 'Nenhuma planilha importada'; return; }
  const d = new Date(dataCompleta.importadoEm), hoje = new Date().toDateString() === d.toDateString();
  const quando = hoje ? 'às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'em ' + d.toLocaleDateString('pt-BR');
  if (sync.estado === 'erro' && temLink) { pt.className = 'pt erro'; txt.textContent = `Sem conexão · dados lidos ${quando}`; return; }
  pt.className = 'pt';
  txt.textContent = `${dataCompleta.origem === 'link' ? 'Planilha em dia' : 'Planilha carregada'} · lida ${quando}`;
}
function fecharMenu() { document.body.classList.remove('menu-aberto'); $('#veu').hidden = true; }

function render() {
  if (!usuario) return;
  renderUsuario();
  $('#fonte').textContent = fonteTexto();
  estadoPlanilha();
  // botão do topo mostra o tema para o qual vai mudar (sol = clarear, lua = escurecer)
  const escuro = temaAtual() === 'dark', tb = $('#temaBtn');
  tb.classList.toggle('escuro', escuro);
  tb.title = escuro ? 'Mudar para tela clara' : 'Mudar para tela escura';
  tb.setAttribute('aria-label', tb.title);
  const vazio = !data;
  $('#vazio').hidden = !vazio;
  $('#pdf').disabled = vazio;
  $('#busca').hidden = vazio;
  renderTopo();
  document.querySelectorAll('main > .tab').forEach(s => { s.hidden = vazio || s.id !== 'tab-' + ui.tab; });
  document.querySelectorAll('.side-nav .item[data-tab]').forEach(b => {
    if (b.dataset.tab === ui.tab && !vazio) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  store(UI_KEY, ui);
  if (vazio) { $('#pontoNovo').hidden = $('#pontoNovoMenu').hidden = true; return; }
  sinalAvisos();
  if (ui.tab === 'geral') renderGeral($('#tab-geral'));
  else if (ui.tab === 'obra') renderObra($('#tab-obra'), ui.obra);
  else if (ui.tab === 'medicoes') renderMedicoes();
  else if (ui.tab === 'config') renderConfig();
}

function init() {
  // Link de senha do e-mail (#/senha/CÓDIGO): guarda o código e tira do endereço antes de qualquer coisa
  const mLink = /^#\/senha\/([a-f0-9]{32,})$/i.exec(location.hash);
  const codigoInicial = mLink ? mLink[1] : null;
  if (mLink) history.replaceState(null, '', location.pathname + location.search + '#/geral');
  dataCompleta = load(STORE_KEY);
  ui = Object.assign(ui, load(UI_KEY) || {});
  ui.f = ui.f || {};
  if (!ROTAS.includes(ui.tab)) ui.tab = 'geral';
  const r0 = lerHash();
  if (r0) aplicar(r0);
  history.replaceState({ d: profundidade() }, '', hashDe(ui));
  window.addEventListener('popstate', () => { const r = lerHash(); if (r) aplicar(r); fecharMenu(); render(); });

  for (const id of ['#arquivo', '#arquivo2', '#arquivo3']) {
    $(id).addEventListener('change', e => { const f = e.target.files[0]; if (f) importar(f); e.target.value = ''; });
  }
  document.querySelector('.side-nav').addEventListener('click', e => {
    const b = e.target.closest('.item[data-tab]');
    if (!b || !data) return;
    const tab = b.dataset.tab;
    navegar(tab === 'medicoes' ? { tab, f: ui.tab === 'medicoes' ? ui.f : {}, de: null } : { tab });
  });
  $('#voltar').addEventListener('click', voltar);
  $('#trilha').addEventListener('click', e => {
    const a = e.target.closest('a[data-i]'); if (!a) return;
    e.preventDefault();
    navegar(trilha()[+a.dataset.i].r);
  });
  $('#menuBtn').addEventListener('click', () => { document.body.classList.add('menu-aberto'); $('#veu').hidden = false; });
  $('#veu').addEventListener('click', fecharMenu);
  $('#tab-geral').addEventListener('click', e => {
    const b = e.target.closest('[data-r="modo"] button');
    if (b) { ui.modo = b.dataset.modo; render(); return; }
    const tr = e.target.closest('tr[data-obra]');
    if (tr) navegar({ tab: 'obra', obra: +tr.dataset.obra });
  });
  $('#tab-obra').addEventListener('click', e => { const b = e.target.closest('[data-r="chips"] button'); if (b) navegar({ tab: 'obra', obra: +b.dataset.obra }, { substituir: true }); });
  $('#temaSeg').addEventListener('click', e => { const b = e.target.closest('button[data-tema]'); if (b) definirTema(b.dataset.tema); });
  $('#temaBtn').addEventListener('click', () => definirTema(temaAtual() === 'dark' ? 'light' : 'dark'));
  $('#cfgSomaLinha').addEventListener('change', e => store(SOMA_LINHA_KEY, e.target.checked ? '1' : '0'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

  // Filtros: atualizam o endereço sem criar um passo novo no Voltar
  const fmap = { '#fObra': 'obra', '#fTipo': 'tipo', '#fStatus': 'status', '#fDe': 'de', '#fAte': 'ate', '#fBusca': 'busca' };
  for (const [sel, k] of Object.entries(fmap)) {
    $(sel).addEventListener(sel === '#fBusca' ? 'input' : 'change', e => {
      ui.f = { ...ui.f, [k]: e.target.value };
      navegar({ tab: 'medicoes', f: ui.f, de: ui.de }, { substituir: true });
    });
  }
  $('#limpar').addEventListener('click', () => { $('#fBusca').value = ''; navegar({ tab: 'medicoes', f: {}, de: null }, { substituir: true }); });
  $('#csv').addEventListener('click', exportarCSV);
  $('#xlsx').addEventListener('click', exportarXLSX);
  $('#apagar').addEventListener('click', apagarDados);
  $('#tab-geral').addEventListener('change', e => {
    if (e.target.matches('[data-r="ate"]')) navegar({ tab: 'geral', ate: e.target.value }, { substituir: true });
  });
  // Mesmo mês da "Posição" da visão geral: vale para o resumo da matriz de qualquer obra.
  $('#tab-obra').addEventListener('change', e => {
    if (e.target.matches('[data-r="ateMatriz"]')) { ui.ate = e.target.value; store(UI_KEY, ui); render(); }
  });

  // Busca rápida
  const bi = $('#buscaInput');
  bi.addEventListener('input', mostrarBusca);
  bi.addEventListener('focus', () => { if (bi.value) mostrarBusca(); });
  bi.addEventListener('keydown', e => {
    const itens = [...$('#buscaLista').querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!itens.length) return;
      buscaSel = (buscaSel + (e.key === 'ArrowDown' ? 1 : -1) + itens.length) % itens.length;
      itens.forEach((b, i) => b.classList.toggle('sel', i === buscaSel));
      itens[buscaSel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); escolherBusca(buscaSel); }
    else if (e.key === 'Escape') { bi.value = ''; fecharBusca(); }
  });
  $('#buscaLista').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) escolherBusca(+b.dataset.i); });
  $('#buscaBtn').addEventListener('click', () => {
    document.documentElement.style.setProperty('--topo-h', document.querySelector('.topo').offsetHeight + 'px');
    $('#busca').classList.toggle('aberta');
    if ($('#busca').classList.contains('aberta')) bi.focus(); else fecharBusca();
  });
  document.addEventListener('click', e => { if (!e.target.closest('#busca')) fecharBusca(); });

  // Menu Gerar PDF
  const menu = $('#pdfMenu'), btn = $('#pdf');
  const fechar = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-pdf]'); if (!b) return;
    fechar();
    if (b.dataset.pdf === 'tela') pdfTela(); else abrirEscolhaRelatorio();
  });
  $('#relDlg').addEventListener('change', conferirEscolha);
  $('#relTodas').addEventListener('click', () => {
    const cs = [$('#relGeral'), ...$('#relObras').querySelectorAll('input')];
    const marcar = cs.some(c => !c.checked);
    cs.forEach(c => { c.checked = marcar; });
    conferirEscolha();
  });
  $('#relDlg').addEventListener('close', () => { if ($('#relDlg').returnValue === 'ok') pdfCompleto(escolhaRelatorio()); });
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) fechar(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { fechar(); fecharMenu(); } });

  // Arrastar e soltar (PC)
  const drop = $('#drop');
  window.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  window.addEventListener('dragleave', () => drop.classList.remove('over'));
  window.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files[0]; if (f) importar(f);
  });

  let rt, larg = innerWidth;
  window.addEventListener('resize', () => {
    if (innerWidth === larg) return; // ignora a barra do navegador do celular abrindo/fechando
    larg = innerWidth; clearTimeout(rt); rt = setTimeout(render, 150);
  });

  // ?src=arquivo.xlsx carrega uma planilha publicada no mesmo servidor (útil para intranet)
  // &relatorio deixa o relatório completo montado para impressão (usado para gerar PDF automático)
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (src) {
    fetch(src).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(b => importar(new File([b], decodeURIComponent(src.split('/').pop()))))
      .then(() => {
        if (!params.has('relatorio') || !data) return;
        // &obras=0,2 e &geral=0 escolhem o conteúdo (como na janela do Gerar PDF)
        const ob = params.get('obras');
        montarRelatorio({ geral: params.get('geral') !== '0', obras: ob ? ob.split(',').map(Number) : data.obras.map((_, i) => i) });
        rodapePDF('Relatório');
        document.body.classList.add('imprimindo-relatorio');
      })
      .catch(e => toast('Não foi possível carregar ' + src + ': ' + e.message));
  }

  // Atualização automática: ao abrir, a cada 10 minutos e ao voltar para o app (se passou do intervalo)
  $('#sincronizar').addEventListener('click', () => sincronizar({ manual: true }));
  $('#atualizarAgora').addEventListener('click', () => sincronizar({ manual: true }));
  $('#salvarFonte').addEventListener('click', () => {
    const v = $('#fonteUrl').value.trim();
    store(FONTE_KEY, v);
    toast(v ? 'Link salvo. Buscando a planilha…' : 'Atualização automática desligada. Use a importação manual.');
    estadoPlanilha();
    if (v) sincronizar({ manual: true });
  });
  const talvezSincronizar = () => { if (document.visibilityState === 'visible' && Date.now() - sync.ultima > INTERVALO_SYNC) sincronizar(); };
  document.addEventListener('visibilitychange', talvezSincronizar);
  setInterval(talvezSincronizar, 60 * 1000);
  if (!src) sincronizar();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Login e senhas (servidor Google)
  $('#loginForm').addEventListener('submit', entrar);
  $('#trocaForm').addEventListener('submit', salvarTroca);
  $('#trocaCancelar').addEventListener('click', () => { trocaPendente = null; if (token) api('sair').catch(() => {}); token = null; mostrarLogin(); });
  $('#esqueciBtn').addEventListener('click', () => { $('#esqueciUsuario').value = $('#loginUsuario').value.trim(); mostrarTela('#esqueciForm'); });
  $('#esqueciForm').addEventListener('submit', pedirLink);
  $('#senhaLinkForm').addEventListener('submit', salvarSenhaLink);
  document.querySelectorAll('[data-voltar-login]').forEach(b => b.addEventListener('click', () => { codigoLink = null; mostrarLogin(); }));
  $('#sair').addEventListener('click', sair);
  $('#minhaSenhaForm').addEventListener('submit', alterarMinhaSenha);
  // Usuários (admin)
  $('#usuForm').addEventListener('submit', salvarUsuario);
  $('#usuForm').addEventListener('change', e => { if (e.target.name === 'modoSenha' || e.target.id === 'novoAdmin') renderUsuarios(); });
  $('#usuCancelar').addEventListener('click', limparFormUsuario);
  $('#linkCopiar').addEventListener('click', () => copiarTexto($('#linkMsg').value, 'Mensagem copiada. Cole no WhatsApp ou no Teams.'));
  $('#linkSoLink').addEventListener('click', () => copiarTexto($('#linkMsg').dataset.link, 'Link copiado.'));
  $('#usuLista').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.editar) editarUsuario(b.dataset.editar);
    if (b.dataset.link) acaoUsuario('enviarLink', b.dataset.link);
    if (b.dataset.convite) linkConvite(b.dataset.convite);
    if (b.dataset.remover) acaoUsuario('removerUsuario', b.dataset.remover);
  });
  // Usuário sugerido a partir do nome (ex.: "João Silva" → joao.silva), até a pessoa digitar outro
  $('#novoNome').addEventListener('input', () => { if (!editando && !$('#novoUsuario').dataset.manual) $('#novoUsuario').value = usuarioDeNome($('#novoNome').value); });
  $('#novoUsuario').addEventListener('input', () => { $('#novoUsuario').dataset.manual = '1'; });

  // Link de senha vindo do e-mail (convite ou "esqueci minha senha"), ao abrir ou com o app já aberto
  const abrirLinkSenha = codigo => {
    if (token) api('sair').catch(() => {});
    codigoLink = codigo;
    limparAparelho();
    mostrarTela('#senhaLinkForm');
  };
  window.addEventListener('hashchange', () => {
    const m = /^#\/senha\/([a-f0-9]{32,})$/i.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search + '#/geral');
    abrirLinkSenha(m[1]);
  });
  if (codigoInicial) { abrirLinkSenha(codigoInicial); return; }
  if (!API_URL) { mostrarLogin('O app ainda não foi ligado ao servidor: preencha API_URL em config.js (ver LEIA-ME).'); return; }
  const s = sessaoSalva();
  if (!s) { mostrarLogin(); return; }
  token = s.token; manterSessao = s.manter;
  iniciarSessao(s.usuario); // abre com os dados guardados; a sincronização confere a sessão no servidor
}

init();
