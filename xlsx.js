'use strict';
// Leitor mínimo de .xlsx, 100% no navegador e sem bibliotecas externas.
// Abre o ZIP, descompacta com DecompressionStream e lê os valores já calculados pelo Excel.

const XLSX_MIN = (() => {
  async function readZip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('O arquivo não parece ser um .xlsx válido.');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const files = {};
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = dec.decode(new Uint8Array(buf, off + 46, nameLen));
      const lName = dv.getUint16(localOff + 26, true);
      const lExtra = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lName + lExtra;
      files[name] = { method, data: new Uint8Array(buf, start, csize) };
      off += 46 + nameLen + extraLen + commLen;
    }
    return files;
  }

  async function inflate(entry) {
    if (entry.method === 0) return entry.data;
    if (entry.method !== 8) throw new Error('Compressão não suportada no arquivo.');
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Este navegador é antigo demais para ler .xlsx. Atualize o Chrome/Safari.');
    }
    const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function colNum(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
    return n;
  }

  function attrLocal(el, local) {
    for (const a of el.attributes) if (a.localName === local) return a.value;
    return null;
  }

  // ---------- Recálculo de fórmulas simples ----------
  // O Google Planilhas grava o resultado das fórmulas com só ~10 dígitos (R$ 451.016.209,4 em vez de ,43).
  // Recalculamos as fórmulas simples (SUM, + - * /, referências na mesma aba) a partir dos valores digitados,
  // que vêm completos. Fórmula que não entendemos (outra aba, outra função, erro) fica com o valor gravado.
  const colLetra = n => { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  // Fórmula compartilhada: o Excel/Google grava só a primeira; as demais são a mesma deslocada.
  function moverFormula(ft, dr, dc) {
    return ft.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (_, ca, col, ra, row) =>
      ca + (ca ? col : colLetra(colNum(col) + dc)) + ra + (ra ? row : +row + dr));
  }
  function recalcular(grid, formulas) {
    const cache = {}, emCurso = new Set();
    const FALHA = {};
    const valor = (r, c) => {
      const k = r + ':' + c;
      if (formulas[k] != null) return calc(k);
      const v = grid[r] && grid[r][c];
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return v;
      throw FALHA;
    };
    const calc = k => {
      if (k in cache) { if (cache[k] === FALHA) throw FALHA; return cache[k]; }
      if (emCurso.has(k)) throw FALHA;
      emCurso.add(k);
      try { cache[k] = avaliar(formulas[k]); return cache[k]; }
      catch (e) { cache[k] = FALHA; throw FALHA; }
      finally { emCurso.delete(k); }
    };
    // Avaliador de expressões: números, refs (A1, $A$1), SUM(intervalos/refs/expr), + - * / e parênteses.
    function avaliar(txt) {
      const tk = txt.replace(/\s+/g, '').match(/\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?|SUM\(|\d+(\.\d+)?(E[+-]?\d+)?|[-+*/(),]|./gi) || [];
      let i = 0;
      const ref = s => { const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(s); return [+m[2], colNum(m[1].toUpperCase())]; };
      const prim = () => {
        const t = tk[i++];
        if (t == null) throw FALHA;
        if (t === '-') return -prim();
        if (t === '+') return prim();
        if (t === '(') { const v = soma(); if (tk[i++] !== ')') throw FALHA; return v; }
        if (/^SUM\($/i.test(t)) {
          let total = 0;
          for (;;) {
            const a = tk[i];
            if (a && a.includes(':')) {
              i++;
              const [p, q] = a.split(':'), [r1, c1] = ref(p), [r2, c2] = ref(q);
              for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++)
                for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
                  const k = r + ':' + c;
                  if (formulas[k] != null) total += calc(k);
                  else { const v = grid[r] && grid[r][c]; if (typeof v === 'number') total += v; } // texto é ignorado no SUM
                }
            } else total += soma();
            const s = tk[i++];
            if (s === ')') return total;
            if (s !== ',') throw FALHA;
          }
        }
        if (/^\d/.test(t)) return Number(t);
        if (/^\$?[A-Z]{1,3}\$?\d+$/i.test(t)) { const [r, c] = ref(t); return valor(r, c); }
        throw FALHA;
      };
      const prod = () => { let v = prim(); while (tk[i] === '*' || tk[i] === '/') { const o = tk[i++], w = prim(); v = o === '*' ? v * w : v / w; } return v; };
      const soma = () => { let v = prod(); while (tk[i] === '+' || tk[i] === '-') { const o = tk[i++], w = prod(); v = o === '+' ? v + w : v - w; } return v; };
      const v = soma();
      if (i !== tk.length || !isFinite(v)) throw FALHA;
      return v;
    }
    for (const k of Object.keys(formulas)) {
      const [r, c] = k.split(':').map(Number);
      const gravado = grid[r] && grid[r][c];
      if (typeof gravado !== 'number') continue;
      try {
        const v = calc(k);
        // Só troca se for o mesmo número com mais casas (segurança contra fórmula mal interpretada)
        if (Math.abs(v - gravado) <= Math.max(0.01, Math.abs(gravado) * 1e-7)) grid[r][c] = v;
      } catch (e) { /* mantém o valor gravado */ }
    }
  }

  // Retorna [{ name, grid }] onde grid[linha][coluna] = valor (números 1-based).
  async function read(buf) {
    const files = await readZip(buf);
    const dec = new TextDecoder('utf-8');
    const text = async p => (files[p] ? dec.decode(await inflate(files[p])) : null);
    const xml = s => new DOMParser().parseFromString(s, 'application/xml');

    const ss = [];
    const ssText = await text('xl/sharedStrings.xml');
    if (ssText) {
      for (const si of xml(ssText).getElementsByTagName('si')) {
        let t = '';
        for (const n of si.getElementsByTagName('t')) if (n.parentNode.localName !== 'rPh') t += n.textContent;
        ss.push(t);
      }
    }

    const wbText = await text('xl/workbook.xml');
    const relText = await text('xl/_rels/workbook.xml.rels');
    if (!wbText || !relText) throw new Error('Estrutura do .xlsx não reconhecida.');
    const rels = {};
    for (const r of xml(relText).getElementsByTagName('Relationship')) {
      let t = r.getAttribute('Target');
      t = t.startsWith('/') ? t.slice(1) : 'xl/' + t;
      rels[r.getAttribute('Id')] = t;
    }

    const sheets = [];
    for (const s of xml(wbText).getElementsByTagName('sheet')) {
      const path = rels[attrLocal(s, 'id')];
      const body = path && await text(path);
      if (!body) continue;
      const grid = {};
      const formulas = {}, masters = {};
      let maxRow = 0, maxCol = 0;
      for (const c of xml(body).getElementsByTagName('c')) {
        const m = /^([A-Z]+)(\d+)$/.exec(c.getAttribute('r') || '');
        if (!m) continue;
        const t = c.getAttribute('t');
        const vEl = c.getElementsByTagName('v')[0];
        const v = vEl ? vEl.textContent : null;
        const fEl = c.getElementsByTagName('f')[0];
        if (fEl && !t) {
          const r0 = +m[2], c0 = colNum(m[1]), si = fEl.getAttribute('si');
          let ft = fEl.textContent;
          if (fEl.getAttribute('t') === 'shared') {
            if (ft) masters[si] = { ft, r0, c0 };
            else if (masters[si]) ft = moverFormula(masters[si].ft, r0 - masters[si].r0, c0 - masters[si].c0);
          }
          if (ft) formulas[r0 + ':' + c0] = ft;
        }
        let val = null;
        if (t === 's') val = v != null ? ss[+v] : null;
        else if (t === 'inlineStr') val = c.textContent;
        else if (t === 'str' || t === 'e') val = v;
        else if (t === 'b') val = v === '1';
        else if (v != null && v !== '') val = Number(v);
        if (val == null || val === '') continue;
        const row = +m[2], col = colNum(m[1]);
        (grid[row] = grid[row] || {})[col] = val;
        if (row > maxRow) maxRow = row;
        if (col > maxCol) maxCol = col;
      }
      recalcular(grid, formulas);
      // Comentários das células (ex.: "PREVISTO" no cabeçalho de um BM)
      const comments = {};
      const relTxt = await text(path.replace(/worksheets\/([^/]+)$/, 'worksheets/_rels/$1.rels'));
      if (relTxt) {
        for (const r of xml(relTxt).getElementsByTagName('Relationship')) {
          if (!/\/comments$/.test(r.getAttribute('Type') || '')) continue;
          const alvo = new URL(r.getAttribute('Target'), 'http://x/' + path).pathname.slice(1);
          const cTxt = await text(alvo);
          if (!cTxt) continue;
          for (const c of xml(cTxt).getElementsByTagName('comment')) {
            // Comentário encadeado vem com um aviso do Excel antes do texto real ("Comentário:" / "Comment:")
            const partes = (c.textContent || '').split(/Coment[aá]rio:|Comment:/);
            comments[c.getAttribute('ref')] = partes[partes.length - 1].trim();
          }
        }
      }
      sheets.push({ name: s.getAttribute('name'), state: s.getAttribute('state') || 'visible', grid, maxRow, maxCol, comments, formulas });
    }
    return sheets;
  }

  // ---------- Escrita (.xlsx simples, sem compressão) ----------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  })();
  function zip(files) {
    const enc = new TextEncoder(), partes = [], central = [];
    let off = 0;
    for (const [nome, texto] of files) {
      const n = enc.encode(nome), d = enc.encode(texto), crc = CRC(d);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
      partes.push(h.buffer, n, d);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, n.length, true);
      c.setUint32(42, off, true);
      central.push(c.buffer, n);
      off += 30 + n.length + d.length;
    }
    const tam = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, tam, true); e.setUint32(16, off, true);
    return new Blob([...partes, ...central, e.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const xe = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const col = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  // abas: [{ nome, larguras: [..], linhas: [[celula,...]], filtro: bool, congelar: bool }]
  // celula: string | number | { v, s } | { f: 'SUM(...)', s }; s = estilo: 1 cabeçalho, 2 moeda, 3 moeda negrito, 4 negrito
  function write(abas) {
    const sheets = abas.map((a, si) => {
      const rows = a.linhas.map((ln, r) => `<row r="${r + 1}">` + ln.map((c, ci) => {
        if (c == null || c === '') return '';
        const ref = col(ci) + (r + 1);
        const o = typeof c === 'object' ? c : { v: c };
        const s = o.s ? ` s="${o.s}"` : '';
        if (o.f) return `<c r="${ref}"${s}><f>${xe(o.f)}</f></c>`;
        if (typeof o.v === 'number' && isFinite(o.v)) return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xe(o.v)}</t></is></c>`;
      }).join('') + '</row>').join('');
      const ncol = Math.max(...a.linhas.map(l => l.length));
      const cols = a.larguras ? '<cols>' + a.larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
      const pane = a.congelar ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
      const af = a.filtro ? `<autoFilter ref="A1:${col(ncol - 1)}${a.filtroAte || a.linhas.length}"/>` : '';
      return { nome: a.nome, af: a.filtro ? `'${a.nome.replace(/'/g, "''")}'!$A$1:$${col(ncol - 1)}$${a.filtroAte || a.linhas.length}` : null, si,
        xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pane}${cols}<sheetData>${rows}</sheetData>${af}</worksheet>` };
    });
    const files = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map(s => `<Override PartName="/xl/worksheets/sheet${s.si + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map(s => `<sheet name="${xe(s.nome)}" sheetId="${s.si + 1}" r:id="rId${s.si + 1}"/>`).join('') + '</sheets>' +
        (sheets.some(s => s.af) ? '<definedNames>' + sheets.filter(s => s.af).map(s => `<definedName name="_xlnm._FilterDatabase" localSheetId="${s.si}" hidden="1">${xe(s.af)}</definedName>`).join('') + '</definedNames>' : '') + '</workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(s => `<Relationship Id="rId${s.si + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.si + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00;[Red]-&quot;R$&quot; #,##0.00"/></numFmts>' +
        '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF111214"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="medium"><color rgb="FFF28C28"/></top><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
      ...sheets.map(s => [`xl/worksheets/sheet${s.si + 1}.xml`, s.xml])
    ];
    return zip(files);
  }

  return { read, write };
})();
