'use strict';
// Converte as abas da planilha "RENOVÁVEIS E HÍDRICAS - Cont. faturamento" no modelo do app.
// A leitura é feita por rótulos (MEDIÇÃO, STATUS, "Medido até BM de...") e não por endereço fixo,
// para continuar funcionando quando novas colunas de BM ou linhas forem acrescentadas.

const MODEL = (() => {
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
  const isNum = v => typeof v === 'number' && isFinite(v);
  const num = v => (isNum(v) ? v : 0);

  const MESES = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };
  const MES_NOME = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  // "Abr.2025", "Agos.2026", "Outubro.2026" -> { ym: 202504, label: 'abr/2025' }
  function parseMes(txt) {
    const t = norm(txt);
    const y = /(20\d\d)/.exec(t);
    const m = /^([A-Z]{3})/.exec(t);
    if (y && m && MESES[m[1]]) {
      const mm = MESES[m[1]];
      return { ym: +y[1] * 100 + mm, label: `${MES_NOME[mm]}/${y[1]}` };
    }
    if (y) return { ym: +y[1] * 100, label: y[1] };
    return { ym: null, label: String(txt ?? '').trim() || '—' };
  }

  function bmNum(txt) {
    const t = norm(txt);
    if (t.startsWith('DOWNPAYMENT')) return 0;
    const m = /BM\s*0*(\d+)/.exec(t);
    return m ? +m[1] : null;
  }
  function bmRange(txt) {
    const t = norm(txt);
    const r = /BM\s*0*(\d+)\s*A\s*0*(\d+)/.exec(t);
    if (r) { const a = []; for (let i = +r[1]; i <= +r[2]; i++) a.push(i); return a; }
    const n = bmNum(txt);
    return n == null ? [] : [n];
  }
  function normStatus(s) {
    const t = norm(s);
    if (t.startsWith('RECEB')) return 'Recebida';
    if (t.startsWith('FATUR')) return 'Faturada';
    if (t.startsWith('MEDID')) return 'Medida';
    return t ? String(s).trim() : '—';
  }
  function normTipo(s) {
    const t = norm(s);
    if (t.startsWith('REAJUSTE')) return 'Reajuste';
    if (t.startsWith('PI')) return 'PI';
    if (t.startsWith('ADITIVO')) return 'Aditivo';
    if (t.startsWith('LNTP')) return 'LNTP';
    if (t.startsWith('DOWNPAYMENT')) return 'Downpayment';
    return String(s ?? '').trim() || '—';
  }

  const MATRIX_ROWS = {
    'PREVISAO MEDICAO': 'previsao', 'MEDIDO': 'medido', 'REAJUSTE': 'reajuste', 'REAJUSTE 2 MEDIDO': 'reajuste',
    'ADITIVO': 'aditivo', 'FD': 'fd', 'DESCONTO DOWNPAYMENT': 'desconto', 'FATURADO': 'faturado',
    'REAJUSTE FATURADO': 'reajFat', 'REAJUSTE 2 FATURADO': 'reajFat', 'RECEBIDO': 'recebido',
    'REAJUSTE RECEBIDO': 'reajRec', 'REAJUSTE 2 RECEBIDO': 'reajRec'
  };

  function parseObra(sheet) {
    const g = sheet.grid;
    const at = (r, c) => (g[r] ? g[r][c] : undefined);

    // 1) Cabeçalho da tabela de medições
    let hr = null; const hc = {};
    for (let r = 1; r <= sheet.maxRow && hr == null; r++) {
      const row = g[r]; if (!row) continue;
      const labels = Object.entries(row).map(([c, v]) => [+c, norm(v)]);
      if (labels.some(([, v]) => v === 'MEDICAO') && labels.some(([, v]) => v === 'STATUS')) {
        hr = r;
        for (const [c, v] of labels) hc[v] = c;
      }
    }
    if (hr == null) return null;
    const C = {
      bm: hc['MEDICAO'], mes: hc['MES/ANO'], tipo: hc['TIPO'], bruto: hc['FATURAMENTO BRUTO'],
      direto: hc['FATURAMENTO DIRETO'], status: hc['STATUS']
    };

    const alerts = [];
    const medicoes = [];
    let blank = 0;
    for (let r = hr + 1; r <= sheet.maxRow; r++) {
      const bm = at(r, C.bm);
      if (bm == null || bm === '') { if (++blank > 5) break; continue; }
      blank = 0;
      const mes = parseMes(at(r, C.mes));
      const bruto = num(at(r, C.bruto)), direto = num(at(r, C.direto));
      const e = {
        obra: sheet.name, bm: String(bm).trim(), bms: bmRange(bm), mes: mes.label, ym: mes.ym,
        tipo: normTipo(at(r, C.tipo)), bruto, direto, total: bruto + direto, status: normStatus(at(r, C.status)), linha: r
      };
      medicoes.push(e);
      if (bruto < 0 || direto < 0) {
        alerts.push({ nivel: 'critico', texto: `${e.bm} (${e.mes}, ${e.tipo}): faturamento bruto negativo (${fmtBRL(bruto)}). Verifique a fórmula da linha ${r}.` });
      }
    }

    // 2) Bloco REALIZADO / SALDO e participação COSAMPA (coluna A)
    const blocos = { total: {}, cosampa: {} };
    let modo = 'total', share = null, refMes = null, contratoInformado = null, previsao = null;
    for (let r = 1; r <= sheet.maxRow; r++) {
      const a = at(r, 1);
      if (typeof a !== 'string') continue;
      const t = norm(a);
      const cos = /^COSAMPA\s*(\d+(?:[.,]\d+)?)\s*%/.exec(t);
      if (cos) { share = parseFloat(cos[1].replace(',', '.')) / 100; modo = 'cosampa'; continue; }
      const val = { v: at(r, 2), saldo: at(r, 3) };
      const key = t.startsWith('MEDIDO ATE') ? 'medido' : t.startsWith('FATURADO ATE') ? 'faturado'
        : t.startsWith('RECEBIDO ATE') ? 'recebido' : (t.startsWith('FALTA RECEBER') || t.startsWith('FALTA A RECEBER')) ? 'falta' : null;
      if (key && isNum(val.v) && blocos[modo][key] == null) {
        blocos[modo][key] = { v: val.v, saldo: isNum(val.saldo) ? val.saldo : null, linha: r };
        if (key === 'medido' && !refMes) { const m = /BM\s*DE\s*([A-Za-zÀ-ú]+)/i.exec(a); if (m) refMes = m[1]; }
      }
      if (t.startsWith('VALOR DO CONTRATO') && contratoInformado == null && isNum(at(r, 2))) contratoInformado = at(r, 2);
      if (t.startsWith('PREVISAO DE MEDICAO') && isNum(at(r, 2))) previsao = { texto: String(a).trim(), v: at(r, 2) };
    }
    const T = blocos.total;
    const contrato = T.medido && T.medido.saldo != null ? T.medido.v + T.medido.saldo : contratoInformado;

    // 3) Matriz por BM (linhas Medido/Faturado/Recebido... acima da tabela)
    let bmRow = null, cols = [];
    for (let r = 1; r < hr && bmRow == null; r++) {
      const row = g[r]; if (!row) continue;
      const cs = Object.keys(row).map(Number).filter(c => c >= 2 && typeof row[c] === 'string' && bmNum(row[c]) != null).sort((a, b) => a - b);
      if (cs.length >= 3) { bmRow = r; cols = cs; }
    }
    const matrix = { cols: [], rows: {} };
    const letra = n => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    if (bmRow != null) {
      matrix.cols = cols.map(c => ({ label: String(at(bmRow, c)).trim(), bm: bmNum(at(bmRow, c)), nota: (sheet.comments || {})[letra(c) + bmRow] || '' }));
      for (let r = bmRow + 1; r < hr; r++) {
        const key = MATRIX_ROWS[norm(at(r, 1))];
        if (!key) continue;
        const values = cols.map(c => (isNum(at(r, c)) ? at(r, c) : null));
        const distinct = new Set(values.filter(v => v != null)).size;
        const cur = matrix.rows[key];
        // Abas com linhas de modelo repetidas (CCAC, Paraíso): fica a linha com mais valores distintos.
        if (!cur || distinct >= cur.distinct) matrix.rows[key] = { label: String(at(r, 1)).trim(), values, distinct, linha: r };
      }
    }

    // Resumo REALIZADO por coluna: lê a fórmula da própria célula ("Medido até BM de…" etc.) e separa
    // quanto cada coluna de BM soma nela. Assim gráficos e matriz seguem a mesma regra da aba
    // (ex.: Seriemas soma de C a V, sem o downpayment; Eixão só conta reajuste a partir da coluna J).
    const F = sheet.formulas || {};
    const resumoCol = {}, formulaResumo = {};
    const vetores = {};
    for (const k of ['medido', 'faturado', 'recebido', 'falta']) {
      const b = T[k]; if (!b) continue;
      const f = F[b.linha + ':2'];
      const d = decompor(f, at, vetores);
      if (!d) continue;
      vetores['B' + b.linha] = d;
      formulaResumo[k] = '=' + f.replace(/^=/, '');
      const soma = Object.values(d).reduce((a, v) => a + v, 0);
      const fora = Object.keys(d).map(Number).filter(c => !cols.includes(c) && Math.abs(d[c]) > 0.005);
      if (Math.abs(soma - b.v) > 0.05 || fora.length) {
        alerts.push({ nivel: 'info', texto: `Não foi possível separar por BM a fórmula de "${k}" (${f}); gráficos usam a soma das linhas da matriz.` });
        continue;
      }
      resumoCol[k] = cols.map(c => (c in d ? d[c] : null));
    }

    // Série por BM: medido total, faturado e recebido (incluindo reajuste, FD e desconto de downpayment)
    const R = k => (matrix.rows[k] ? matrix.rows[k].values : []);
    const mesPorBm = {};
    for (const m of medicoes) for (const n of m.bms) if (m.ym && !mesPorBm[n]) mesPorBm[n] = { label: m.mes, ym: m.ym };
    const todas = matrix.cols.map((c, i) => {
      const has = k => R(k)[i] != null;
      const v = k => num(R(k)[i]);
      const doResumo = (k, alt) => (resumoCol[k] ? resumoCol[k][i] : alt());
      const med = doResumo('medido', () => (has('medido') || has('reajuste') || has('aditivo') ? v('medido') + v('reajuste') + v('aditivo') : null));
      const fat = doResumo('faturado', () => (has('faturado') || has('reajFat') ? v('faturado') + v('reajFat') + v('fd') + v('desconto') : null));
      const rec = doResumo('recebido', () => (has('recebido') || has('reajRec') ? v('recebido') + v('reajRec') + v('fd') + v('desconto') : null));
      const prev = has('previsao') ? v('previsao') : null;
      const mes = mesPorBm[c.bm];
      return { label: c.label, bm: c.bm, mes: mes ? mes.label : '', ym: mes ? mes.ym : null, med, fat, rec, prev };
    });
    // Mês usado na "posição até o mês": BM sem mês na tabela (ex.: LNTP, downpayment) fica no mês do
    // primeiro BM com data; BM depois do último com data avança um mês por coluna (BM 34 - Outubro...).
    const conhecidos = todas.map((s, i) => [i, s.ym]).filter(([, ym]) => ym);
    todas.forEach((s, i) => {
      if (s.ym) { s.ymPos = s.ym; return; }
      if (!conhecidos.length) return;
      const ant = conhecidos.filter(([j]) => j < i).pop();
      if (!ant) { s.ymPos = conhecidos[0][1]; return; }
      let ym = ant[1] % 100 ? ant[1] : ant[1] + 12; // "só o ano" conta como dezembro
      for (let n = ant[0]; n < i; n++) ym = ym % 100 === 12 ? ym + 89 : ym + 1;
      s.ymPos = ym;
    });
    todas.forEach((s, i) => { s.fal = resumoCol.falta ? resumoCol.falta[i] : null; matrix.cols[i].ymPos = s.ymPos; });
    const series = todas.filter(s => s.bm !== 0 || s.med || s.fat || s.rec); // Downpayment é adiantamento: só entra se a fórmula do resumo o somar.

    // Previsões de medição: linha "Previsão medição" da matriz, ou BM com comentário "previsto/previsão"
    // que ainda não foi faturado nem recebido.
    const previsoes = [];
    matrix.cols.forEach((c, i) => {
      const pv = R('previsao')[i];
      const mes = mesPorBm[c.bm];
      if (pv) { previsoes.push({ bm: c.label, mes: mes ? mes.label : '', v: pv, fonte: 'linha "Previsão medição"' }); return; }
      if (!/previs/i.test(c.nota)) return;
      const sts = medicoes.filter(m => m.bms.includes(c.bm)).map(m => m.status);
      if (sts.some(s => s === 'Recebida' || s === 'Faturada')) return;
      const v = num(R('medido')[i]) + num(R('reajuste')[i]);
      if (v) previsoes.push({ bm: c.label, mes: mes ? mes.label : '', v, fonte: `comentário: "${c.nota}"` });
    });

    // Alertas de consistência
    const refErros = Object.values(g).reduce((n, row) => n + Object.values(row).filter(v => v === '#REF!').length, 0);
    if (refErros) alerts.push({ nivel: 'aviso', texto: `${refErros} células com erro #REF! na aba (linhas de modelo sem uso). Não afetam os totais exibidos.` });
    const naTabela = new Set(medicoes.flatMap(m => m.bms));
    const faltando = series.filter(s => s.med && s.bm != null && !naTabela.has(s.bm)).map(s => s.label);
    if (faltando.length) alerts.push({ nivel: 'aviso', texto: `BM com valor medido na matriz, mas ausente da tabela de medições: ${faltando.join(', ')}.` });
    // Recebido maior que faturado no mesmo BM (ex.: Seriemas BM 18) é ajuste intencional lançado só no
    // recebimento: não gera aviso. No app, o "faturado a receber" fica em zero em vez de negativo.
    if (share == null) alerts.push({ nivel: 'info', texto: 'A aba não informa o percentual de participação da COSAMPA; a obra fica fora do total "Parte COSAMPA".' });
    if (contratoInformado != null && contrato != null && Math.abs(contratoInformado - contrato) > 1) {
      alerts.push({ nivel: 'info', texto: `Valor do contrato usado no saldo (${fmtBRL(contrato)}) difere do primeiro "Valor do Contrato" da aba (${fmtBRL(contratoInformado)}).` });
    }

    const pick = k => (T[k] ? T[k].v : null);
    return {
      nome: sheet.name, share, refMes, contrato, previsao,
      medido: pick('medido'), faturado: pick('faturado'), recebido: pick('recebido'),
      falta: pick('falta') ?? (pick('medido') != null && pick('recebido') != null ? pick('medido') - pick('recebido') : null),
      medicoes, matrix: { cols: matrix.cols, rows: Object.fromEntries(Object.entries(matrix.rows).map(([k, v]) => [k, { label: v.label, values: v.values, linha: v.linha }])) },
      resumoCol, formulaResumo, linhasResumo: Object.fromEntries(Object.entries(T).map(([k, b]) => [k, b.linha])),
      series, previsoes, alerts
    };
  }

  // Separa uma fórmula do resumo (ex.: =SUM(C11:V11)+SUM(C10:V10)-B20) em valores por coluna da planilha.
  // Aceita SUM de intervalos, células soltas e referências a outras células do resumo já separadas.
  // Retorna { coluna: valor } ou null se a fórmula tiver algo diferente disso.
  function decompor(f, at, vetores) {
    if (typeof f !== 'string') return null;
    const corpo = f.replace(/^=/, '').replace(/\$/g, '').replace(/\s/g, '').toUpperCase();
    const termos = corpo.match(/[+-]?(?:SUM\([^)]*\)|[A-Z]+\d+)/g);
    if (!termos || termos.join('') !== corpo) return null;
    const colN = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    const out = {};
    const add = (c, v) => { out[c] = (out[c] || 0) + v; };
    for (let t of termos) {
      const sg = t[0] === '-' ? -1 : 1;
      t = t.replace(/^[+-]/, '');
      const s = /^SUM\((.*)\)$/.exec(t);
      if (s) {
        for (const rg of s[1].split(/[,;]/)) {
          const q = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(rg);
          if (!q) return null;
          const c1 = colN(q[1]), r1 = +q[2], c2 = q[3] ? colN(q[3]) : c1, r2 = q[4] ? +q[4] : r1;
          for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++)
            for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) { const v = at(r, c); if (isNum(v)) add(c, sg * v); }
        }
      } else if (vetores[t]) {
        for (const [c, v] of Object.entries(vetores[t])) add(+c, sg * v);
      } else {
        const q = /^([A-Z]+)(\d+)$/.exec(t);
        const v = at(+q[2], colN(q[1]));
        if (isNum(v)) add(colN(q[1]), sg * v);
      }
    }
    return out;
  }

  function fmtBRL(v) {
    return isNum(v) ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';
  }

  function build(sheets, fileName) {
    const obras = sheets.filter(s => s.state === 'visible').map(parseObra).filter(Boolean);
    if (!obras.length) throw new Error('Nenhuma aba com a tabela "MEDIÇÃO | MÊS/ANO | TIPO | ... | STATUS" foi encontrada.');
    return { arquivo: fileName, importadoEm: new Date().toISOString(), obras };
  }

  return { build, fmtBRL, MES_NOME };
})();
