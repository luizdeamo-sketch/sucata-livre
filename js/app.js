// Sucata Livre · app (v2 classificado: quem vende anuncia sem preço, quem compra manda oferta que só o vendedor vê)
(function () {
  const C = window.SLV_CONFIG;
  const sb = window.supabase.createClient(C.url, C.anon, { auth: { persistSession: true, storageKey: "slv-auth" } });

  // ── utilidades ───────────────────────────────────────────────────────────
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const digitos = (s) => String(s ?? "").replace(/\D/g, "");
  const mascara = (v, m) => { let i = 0; const d = digitos(v); return m.replace(/9/g, () => d[i++] ?? "").replace(/[^\d]+$/, ""); };
  const fmtCPF = (v) => mascara(v, "999.999.999-99");
  const fmtCNPJ = (v) => mascara(v, "99.999.999/9999-99");
  const fmtCEP = (v) => mascara(v, "99999-999");
  const fmtTel = (v) => { const d = digitos(v).replace(/^55(?=\d{10,11}$)/, ""); return d.length > 10 ? mascara(d, "(99) 99999-9999") : mascara(d, "(99) 9999-9999"); };
  const reais = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const lerReais = (s) => { const n = Number(String(s).replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
  const lerKg = (s) => { const n = Number(String(s).replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0; };
  const km = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const ha = (iso) => {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 60) return `há ${Math.max(1, min)} min`;
    const h = Math.round(min / 60); if (h < 48) return `há ${h} h`;
    return `há ${Math.round(h / 24)} dias`;
  };
  const PRECISAO = { rua: "localização pela rua", bairro: "localização pelo bairro (aproximada)", cidade: "localização pelo centro da cidade (aproximada)" };

  // sem CEP, a vitrine abre no centro de Salto (como a OLX abre na cidade): quem chega já vê anúncios
  const LOCAL_PADRAO = { lat: -23.2003, lng: -47.2869, cep: "", bairro: "", cidade: "Salto", uf: "SP", precisao: "cidade", padrao: true };
  const estado = {
    sessao: null, eu: null, vendedor: null, comprador: null, operador: false,
    familias: [], materiais: [], params: {}, respostas: 0,
    local: { ...LOCAL_PADRAO }, // {lat, lng, cep, bairro, cidade, precisao} usado nas listas e no mapa
    familiaFiltro: null,  // filtro de material das listas
    raio: 10,             // filtro de distância das listas (km)
    abrir: null,          // id de anúncio/oferta para abrir na próxima tela
  };
  const MAT = () => Object.fromEntries(estado.materiais.map((m) => [m.id, m]));

  function avisar(msg, tipo = "info") {
    const el = document.createElement("div");
    el.className = `aviso ${tipo}`; el.textContent = msg;
    $("#avisos").appendChild(el);
    setTimeout(() => el.remove(), tipo === "erro" ? 7000 : 4000);
    if (tipo === "erro") window.Acomp.recusa(msg);
  }

  async function msgErro(error) {
    try { const j = await error.context.json(); if (j?.erro) return j.erro; } catch {}
    const m = error?.message || String(error);
    if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão. Confira a internet e tente de novo.";
    return m.replace(/^.*?:\s*/, "") || "Algo deu errado. Tente de novo.";
  }

  async function ocupado(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { avisar(await msgErro(e), "erro"); window.Acomp.erro(e?.message); } finally { btn.disabled = false; }
  }

  // ── dados ────────────────────────────────────────────────────────────────
  async function carregarCatalogo() {
    if (estado.materiais.length) return;
    const [f, m, p] = await Promise.all([
      sb.from("slv_familias").select("*").order("ordem"),
      sb.from("slv_materiais").select("*").eq("ativo", true).order("ordem"),
      sb.from("slv_parametros").select("chave, valor"),
    ]);
    estado.familias = f.data ?? []; estado.materiais = m.data ?? [];
    estado.params = Object.fromEntries((p.data ?? []).map((x) => [x.chave, x.valor]));
    await carregarReferencia();
  }

  // preço de referência da região: pesquisa da equipe até haver ofertas aceitas suficientes
  async function carregarReferencia() {
    const { data } = await sb.rpc("slv_referencia_regiao");
    estado.ref = Object.fromEntries((data ?? []).map((r) => [r.material_id, r]));
  }
  const reais0 = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const reais2 = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function faixaItens(itens) {
    let mn = 0, mx = 0, ok = false;
    for (const i of itens ?? []) { const r = estado.ref?.[i.material_id]; if (!r || !(Number(i.peso_kg) > 0)) continue; ok = true; mn += i.peso_kg * r.minimo; mx += i.peso_kg * r.maximo; }
    return ok ? [mn, mx] : null;
  }
  const FONTE_REF = { pesquisa: "pesquisa de preço da equipe", estimativa: "estimativa da equipe (a confirmar)", ofertas: "média das ofertas aceitas" };
  function textoEstimativa(itens) {
    const f = faixaItens(itens);
    if (!f) return `<span class="suave">Coloque o peso para ver quanto vale na região.</span>`;
    const fontes = new Set((itens ?? []).filter((i) => i.peso_kg > 0).map((i) => estado.ref?.[i.material_id]?.fonte).filter(Boolean));
    const fonte = fontes.size === 1 ? FONTE_REF[[...fontes][0]] : fontes.has("estimativa") ? FONTE_REF.estimativa : "vendas reais da região e pesquisa da equipe";
    return `<span class="suave">Na região, isso vale</span><b>${reais0(f[0])} a ${reais0(f[1])}</b><span class="suave" style="font-size:.85rem">Referência: ${fonte}. Não mostra o preço de nenhum comprador.</span>`;
  }
  function selloOferta(valor, itens) {
    const f = faixaItens(itens); if (!f) return "";
    return valor > f[1] ? `<span class="etiqueta ok">Acima do preço da região</span>` : valor < f[0] ? `<span class="etiqueta atencao">Abaixo do preço da região</span>` : `<span class="etiqueta">Dentro do preço da região</span>`;
  }
  function tabelaReferencia() {
    const M = MAT();
    return `<div class="cartao"><h3>Preço de referência na região</h3>
      <p class="suave" style="font-size:.9rem">R$ por kg. Começa com a pesquisa da equipe e passa a usar a média das ofertas aceitas quando há volume. Não mostra o preço de nenhum comprador.</p>
      <table class="ref"><tbody>${Object.values(estado.ref ?? {}).map((r) => `<tr><td>${selo(r.material_id)}</td><td>${esc(M[r.material_id]?.nome ?? "")}${r.fonte === "estimativa" ? ` <small class="suave">(estimativa)</small>` : r.fonte === "ofertas" ? ` <small class="suave">(${r.n_ofertas} vendas)</small>` : ""}</td><td>${reais2(r.minimo)} a ${reais2(r.maximo)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  async function carregarPerfil() {
    const uid = estado.sessao.user.id;
    const [u, v, c] = await Promise.all([
      sb.from("slv_usuarios").select("*").eq("id", uid).maybeSingle(),
      sb.from("slv_vendedores").select("*").eq("usuario_id", uid).maybeSingle(),
      sb.from("slv_compradores").select("*").eq("usuario_id", uid).maybeSingle(),
    ]);
    estado.eu = u.data; estado.vendedor = v.data; estado.comprador = c.data;
    estado.operador = !!u.data?.papeis?.includes("operador") && u.data.status === "ativo";
    $("#topo-nome").textContent = estado.eu?.nome ?? "";
    if (!estado.local || estado.local.padrao) {
      const cep = estado.comprador?.cep ?? estado.vendedor?.cep;
      if (cep) {
        const { data: g } = await sb.from("slv_cep_geo").select("cep, lat, lng, bairro, cidade, precisao").eq("cep", cep).maybeSingle();
        if (g) estado.local = { ...g };
      }
    }
    if (!estado.local) estado.local = { ...LOCAL_PADRAO };
    await contarRespostas();
    montarMenu();
  }

  async function contarRespostas() {
    if (!estado.eu) { estado.respostas = 0; return; }
    const { count } = await sb.from("slv_sugestoes").select("id", { count: "exact", head: true })
      .eq("autor_id", estado.sessao.user.id).not("resposta", "is", null).is("retorno", null);
    estado.respostas = count ?? 0;
    const b = $("#menu-badge"); b.hidden = !estado.respostas; b.textContent = estado.respostas;
  }

  // CEP: o navegador pega a coordenada na AwesomeAPI (IP da pessoa) e o servidor confere.
  async function consultarCep(cep) {
    let dica = null;
    try {
      const r = await fetch(`https://cep.awesomeapi.com.br/json/${cep}`);
      if (r.ok) { const d = await r.json(); if (d.lat && d.lng) dica = { lat: Number(d.lat), lng: Number(d.lng) }; }
    } catch { /* o servidor tenta as outras fontes */ }
    const { data, error } = await sb.functions.invoke("slv-cep", { body: { cep, dica } });
    if (error) throw new Error(await msgErro(error));
    return data;
  }

  async function urlsFotos(caminhos) {
    if (!caminhos?.length) return [];
    const { data } = await sb.storage.from("slv-anuncios").createSignedUrls(caminhos, 3600);
    return (data ?? []).map((x) => x.signedUrl).filter(Boolean);
  }

  const tituloItens = (itens) => {
    const M = MAT();
    const p = (itens ?? []).map((i) => `${String(i.peso_kg).replace(".", ",").replace(/,0$/, "")} kg de ${(M[i.material_id]?.nome ?? "material").toLowerCase()}`);
    return p.length > 1 ? `${p.slice(0, -1).join(", ")} e ${p.at(-1)}` : p[0] ?? "Material";
  };
  // selo do material: símbolo químico do metal ou código de reciclagem (no lugar do emoji)
  const selo = (id) => { const m = MAT()[id]; return m ? `<span class="cod ${esc(m.selo_classe ?? "")}" title="${esc(m.nome)}"><b>${esc(m.selo ?? "?")}</b><small>${esc(m.selo_sub ?? "")}</small></span>` : ""; };
  const selosItens = (itens) => `<span class="cods">${(itens ?? []).slice(0, 3).map((i) => selo(i.material_id)).join("")}</span>`;
  const totalKg = (itens) => (itens ?? []).reduce((s, i) => s + Number(i.peso_kg), 0);
  const abertoAgora = (h) => {
    if (!h?.seg_sex) return null;
    const d = new Date(), dia = d.getDay(), agora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const f = dia === 0 ? h.dom : dia === 6 ? h.sab : h.seg_sex;
    return !!f && agora >= f.abre && agora < f.fecha;
  };

  // ── mapa real (Leaflet + OpenStreetMap); o desenho em SVG fica de reserva se o mapa não carregar ──
  // Quem não é comprador aprovado recebe o anúncio de venda com o ponto arredondado (≈ 1 km): no mapa ele vira
  // uma área de 500 m, nunca um pino na porta de quem vende. Comprador é empresa: o pino fica no endereço.
  let mapaPendente = null;
  function mapaHTML(pontos, classe) {
    if (!window.L) return mapaSVG(pontos, classe);
    mapaPendente = { pontos, classe };
    return `<div class="mapa-real" id="mapa-real" role="region" aria-label="Mapa de quem está perto"></div>`;
  }
  function montarMapa(el) {
    const p = mapaPendente; mapaPendente = null;
    const caixa = $("#mapa-real", el); if (!p || !caixa || !window.L) return;
    const c = estado.local, venda = p.classe === "m-anu", aproximado = venda && estado.comprador?.status !== "aprovado";
    const mapa = L.map(caixa, { scrollWheelZoom: false, attributionControl: true }).setView([c.lat, c.lng], 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(mapa);
    const raio = L.circle([c.lat, c.lng], { radius: estado.raio * 1000, color: "#82878e", weight: 2, dashArray: "6 6", fill: false, interactive: false }).addTo(mapa);
    const pino = (txt, cor, extra = "") => L.divIcon({ className: "pino-mapa", html: `<span class="pm ${extra}" style="background:${cor}">${txt}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    L.marker([c.lat, c.lng], { icon: pino("você", "#14171c", "pm-eu"), keyboard: false, zIndexOffset: 1000 }).addTo(mapa)
      .bindTooltip(c.padrao ? "Centro de Salto (digite seu CEP)" : "Você (pelo CEP)");
    const cor = venda ? "#b4461a" : "#1f5c99";
    const limites = [[c.lat, c.lng]];
    p.pontos.forEach((x, i) => {
      if (x.lat == null || x.lng == null) return;
      limites.push([x.lat, x.lng]);
      if (aproximado) L.circle([x.lat, x.lng], { radius: 500, color: cor, weight: 1, fillColor: cor, fillOpacity: .12, interactive: false }).addTo(mapa);
      const m = L.marker([x.lat, x.lng], { icon: pino(i + 1, cor), title: venda ? tituloItens(x.itens) : x.nome }).addTo(mapa);
      m.bindTooltip(`${i + 1}. ${esc(venda ? tituloItens(x.itens) : x.nome)}${aproximado ? " · área aproximada" : ""}`);
      m.on("click", () => {
        const alvo = venda ? $(`[data-abrir="${x.id}"]`, el) : $$(".lista-compra > article", el)[i];
        if (!alvo) return;
        if (venda) alvo.click(); else { alvo.scrollIntoView({ behavior: "smooth", block: "center" }); alvo.classList.add("piscar"); setTimeout(() => alvo.classList.remove("piscar"), 1600); }
      });
    });
    mapa.fitBounds(L.latLngBounds(limites), { padding: [30, 30], maxZoom: 15 });
    setTimeout(() => mapa.invalidateSize(), 200);
  }

  const CIDADES =[["Salto", -23.2003, -47.2869], ["Itu", -23.2642, -47.2992], ["Indaiatuba", -23.0882, -47.2181], ["Sorocaba", -23.5015, -47.4581],
    ["Jundiaí", -23.1857, -46.8841], ["Campinas", -22.9056, -47.0608], ["Cabreúva", -23.3075, -47.1331], ["Porto Feliz", -23.2154, -47.5233], ["Itupeva", -23.1531, -47.0578]];
  function mapaSVG(pontos, classe) {
    const c = estado.local;
    const longe = pontos.map((p) => p.distancia_km).sort((a, b) => a - b)[Math.min(5, pontos.length - 1)] ?? 4;
    const raio = Math.max(3, Math.min(25, Math.ceil(longe + 1)));
    const W = 600, H = 400, k = Math.min(W, H) / 2 / (raio * 1.15), cos = Math.cos(c.lat * Math.PI / 180);
    const xy = (p) => [W / 2 + (p.lng - c.lng) * 111.32 * cos * k, H / 2 - (p.lat - c.lat) * 110.57 * k];
    const den = ([x, y]) => x > -10 && x < W + 10 && y > -10 && y < H + 10;
    const passo = raio > 12 ? 5 : raio > 5 ? 2 : 1;
    let g = `<circle class="m-raio" cx="${W / 2}" cy="${H / 2}" r="${raio * k}"/>`;
    for (const [nome, lat, lng] of CIDADES) { const p = xy({ lat, lng }); if (den(p)) g += `<circle class="m-pc" cx="${p[0]}" cy="${p[1]}" r="3"/><text class="m-cid" x="${p[0] + 7}" y="${p[1] - 6}">${nome}</text>`; }
    pontos.forEach((p, i) => { const q = xy(p); if (den(q)) g += `<circle class="${classe}" cx="${q[0]}" cy="${q[1]}" r="12"/><text class="m-rot" x="${q[0]}" y="${q[1]}">${i + 1}</text>`; });
    g += `<circle class="m-eu" cx="${W / 2}" cy="${H / 2}" r="16"/><text class="m-eu-t" x="${W / 2}" y="${H / 2}">você</text>`;
    g += `<line class="m-esc" x1="16" y1="${H - 18}" x2="${16 + passo * k}" y2="${H - 18}"/><text class="m-esc-t" x="16" y="${H - 26}">${passo} km</text>`;
    return `<div class="mapa"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mapa de quem está perto">${g}</svg></div>`;
  }

  // caixa "Digite seu CEP" no topo das listas
  function caixaCep(titulo) {
    const l = estado.local;
    return `<form class="busca-cep" id="busca-cep">
      <label for="cep-busca">${titulo}</label>
      <div class="busca-linha"><input type="text" id="cep-busca" inputmode="numeric" placeholder="Digite seu CEP" value="${l ? esc(fmtCEP(l.cep)) : ""}">
        <button type="submit" class="btn btn-primario">Buscar</button></div>
      <small class="dica">${l?.padrao ? "📍 Mostrando Salto e região. Digite o seu CEP para ver o que está mais perto de você."
        : l ? `📍 ${esc([l.bairro, l.cidade].filter(Boolean).join(", "))} · ${esc(PRECISAO[l.precisao] ?? "")}` : "Digite o CEP para ver quem está perto."}</small>
    </form>`;
  }
  function ligarCaixaCep(el) {
    const f = $("#busca-cep", el), i = $("#cep-busca", el);
    i.addEventListener("input", () => (i.value = fmtCEP(i.value)));
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      ocupado(f.querySelector("button"), async () => {
        const d = digitos(i.value);
        if (d.length !== 8) throw new Error("Digite os 8 números do CEP.");
        const r = await consultarCep(d);
        if (!r.na_regiao) throw new Error(`${r.geo.cidade} ainda fica fora da região de lançamento (Salto e 50 km em volta).`);
        estado.local = { ...r.geo };
        rota();
      });
    });
  }

  // filtros de distância e material das listas
  const RAIOS = [5, 10, 25, 50];
  function filtrosHTML() {
    return `<div class="filtros">
      <div class="chips" role="group" aria-label="Distância"><span class="rot">Até</span>${RAIOS.map((r) => `<button type="button" class="chip" data-raio="${r}" aria-pressed="${estado.raio === r}">${r} km</button>`).join("")}</div>
      <div class="chips" role="group" aria-label="Material"><span class="rot">Material</span><button type="button" class="chip" data-fam="" aria-pressed="${estado.familiaFiltro == null}">Tudo</button>${estado.familias.map((f) => `<button type="button" class="chip" data-fam="${f.id}" aria-pressed="${estado.familiaFiltro === f.id}">${esc(f.nome)}</button>`).join("")}</div>
    </div>`;
  }
  function ligarFiltros(el) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".filtros [data-raio], .filtros [data-fam]"); if (!b) return;
      if (b.dataset.raio) estado.raio = Number(b.dataset.raio);
      else estado.familiaFiltro = b.dataset.fam ? Number(b.dataset.fam) : null;
      rota();
    });
  }
  // anúncios de exemplo (enquanto a vitrine não tem anúncios reais): um aviso só, no alto da lista
  const avisoExemplos = (lista) => (lista ?? []).some((x) => x.exemplo)
    ? `<p class="aviso-exemplo">Os anúncios com a marca <span class="etiqueta exemplo">Exemplo</span> mostram como a vitrine funciona e não fazem negócio. Eles saem quando chegarem os anúncios de verdade.</p>` : "";
  const nomesMateriais = (ids) => { const M = MAT(); const n = (ids ?? []).map((id) => M[id]?.nome.toLowerCase()).filter(Boolean); return n.length > 1 ? `${n.slice(0, -1).join(", ")} e ${n.at(-1)}` : n[0] ?? "—"; };

  // ── menu e navegação ─────────────────────────────────────────────────────
  function montarMenu() {
    const logado = !!estado.sessao;
    // a vitrine é aberta: os dois primeiros itens valem para todo mundo, com ou sem cadastro
    const itens = [["anuncios", "🔎 Material à venda"], ["quem-compra", "📍 Quem compra"]];
    if (estado.vendedor) itens.push(["anunciar", "➕ Anunciar"], ["meus-anuncios", "📋 Meus anúncios"]);
    if (estado.comprador) itens.push(["inicio-comprador", "🏢 Minha empresa"], ["minhas-ofertas", "💬 Minhas ofertas"],
      ["anunciar-compra", "📣 Anunciar que compro"], ["minhas-procuras", "📋 Meus anúncios de compra"], ["o-que-compro", "📦 O que compro"]);
    if (estado.vendedor) itens.push(["cad-vendedor", "👤 Meu cadastro"]);
    if (logado && (!estado.vendedor || !estado.comprador)) itens.push(["papel", estado.vendedor || estado.comprador ? "➕ Também quero comprar ou vender" : "🏠 Começar a vender ou comprar"]);
    if (logado) itens.push(["sugestoes", "🗨️ Sugestões"]);
    itens.push(["apresentacao", "ℹ️ Como funciona"]);
    if (!logado) itens.push(["entrar", "🔑 Entrar ou criar cadastro"]);
    if (estado.operador) itens.push(["operador", "🗼 Operador"]);
    $("#menu").innerHTML = itens.map(([t, r]) =>
      `<a href="#/${t}" data-tela="${t}">${r}${t === "sugestoes" && estado.respostas ? `<span class="badge">${estado.respostas}</span>` : ""}</a>`).join("")
      + (logado ? `<button type="button" id="btn-sair">🚪 Sair</button>` : "");
    $("#btn-sair")?.addEventListener("click", async () => { await sb.auth.signOut({ scope: "local" }); location.hash = "#/"; location.reload(); });
    if (!logado) $("#topo-nome").innerHTML = `<a class="btn btn-secundario btn-topo" href="#/entrar">Entrar</a>`;
  }

  function abrirMenu(abrir) { $("#menu").hidden = !abrir; $("#menu-fundo").hidden = !abrir; }
  $("#btn-menu").addEventListener("click", () => abrirMenu($("#menu").hidden));
  $("#menu-fundo").addEventListener("click", () => abrirMenu(false));
  $("#menu").addEventListener("click", (e) => e.target.closest("a") && abrirMenu(false));

  function telaInicial() {
    if (estado.vendedor && !estado.comprador) return "quem-compra";
    return "anuncios";
  }

  // vitrine aberta: ver é livre; fazer negócio (WhatsApp, oferta, anúncio) pede cadastro
  const PUBLICAS = new Set(["anuncios", "quem-compra", "apresentacao", "entrar"]);
  const VOLTA = "slv-voltar";
  const guardarVolta = (tela) => { try { sessionStorage.setItem(VOLTA, tela); } catch {} };
  const lerVolta = () => { try { return sessionStorage.getItem(VOLTA); } catch { return null; } };
  const limparVolta = () => { try { sessionStorage.removeItem(VOLTA); } catch {} };
  // devolve true quando a pessoa já pode fazer o negócio; senão leva para entrar ou para o cadastro e volta depois
  function precisa(papel, voltar) {
    guardarVolta(voltar);
    if (!estado.sessao) {
      avisar(papel === "comprador" ? "Para fazer oferta, entre e cadastre a sua empresa. É grátis." : "Para fazer negócio, entre com o seu celular. É grátis.", "info");
      ir("entrar"); return false;
    }
    if (papel === "vendedor" && !estado.vendedor) { ir("cad-vendedor"); return false; }
    if (papel === "comprador" && !estado.comprador) { ir("cad-comprador"); return false; }
    if (papel === "comprador" && estado.comprador.status !== "aprovado") { ir("inicio-comprador"); return false; }
    limparVolta(); return true;
  }
  // seletor do lado (vender ou comprar) no alto da vitrine, e a frase da marca para quem ainda não entrou
  const lado = (atual) => `${estado.sessao ? "" : `<section class="vitrine-topo"><p class="chamada-marca chamada-vitrine">Quem junta, vende.</p>
      <p>Anúncios de sucata e reciclável de Salto e região, sem preço. Ver é livre; para fazer negócio, crie seu cadastro grátis.</p></section>`}
    <nav class="lado" aria-label="O que você quer fazer">
      <a href="#/quem-compra" class="lado-op vende" ${atual === "quem-compra" ? 'aria-current="page"' : ""}>Quero vender<small>quem compra perto</small></a>
      <a href="#/anuncios" class="lado-op compra" ${atual === "anuncios" ? 'aria-current="page"' : ""}>Quero comprar<small>material à venda</small></a>
    </nav>`;

  async function rota() {
    let nome = (location.hash.replace(/^#\/?/, "").split("?")[0]) || telaInicial();
    if (!TELAS[nome]) nome = telaInicial();
    if (!estado.sessao && !PUBLICAS.has(nome)) { guardarVolta(nome); nome = "entrar"; }
    if (nome === lerVolta()) limparVolta();
    // um contêiner novo por tela, para os ouvintes de uma tela não sobrarem na seguinte
    const el = document.createElement("div");
    $("#tela").replaceChildren(el);
    $$("#menu a").forEach((a) => a.classList.toggle("ativo", a.dataset.tela === nome));
    el.innerHTML = `<p class="suave">Carregando…</p>`;
    window.Acomp.tela(nome);
    try {
      await TELAS[nome](el);
      montarMapa(el);
      if (estado.sessao && estado.eu) await retornoNaTela(el, nome);
    } catch (e) {
      el.innerHTML = `<div class="cartao erro"><h3>Não conseguimos abrir esta tela</h3><p>${esc(await msgErro(e))}</p>
        <button class="btn btn-secundario" onclick="location.reload()">Tentar de novo</button></div>`;
      window.Acomp.erro(e?.message);
    }
    $("#tela").focus({ preventScroll: true });
    scrollTo(0, 0);
  }
  addEventListener("hashchange", rota);
  const ir = (nome) => { if (location.hash === `#/${nome}`) rota(); else location.hash = `#/${nome}`; };

  // Retorno para quem sugeriu: a resposta aparece na tela de onde a sugestão saiu.
  async function retornoNaTela(el, nome) {
    const { data } = await sb.from("slv_sugestoes").select("id, texto, resposta, status")
      .eq("autor_id", estado.sessao.user.id).eq("tela", nome).not("resposta", "is", null).is("retorno", null).limit(3);
    for (const s of data ?? []) {
      const box = document.createElement("div");
      box.className = "cartao destaque";
      box.innerHTML = `<h3>Resposta à sua sugestão</h3>
        <p class="suave">Você disse: “${esc(s.texto.slice(0, 160))}”</p><p><b>${esc(s.resposta)}</b></p>
        <div class="acoes"><button class="btn btn-primario" data-r="ficou_bom">Ficou bom</button>
        <button class="btn btn-secundario" data-r="ainda_nao">Ainda não ficou</button></div>`;
      box.addEventListener("click", async (e) => {
        const r = e.target.closest("[data-r]")?.dataset.r; if (!r) return;
        const { error } = await sb.from("slv_sugestoes").update({ retorno: r }).eq("id", s.id);
        if (error) return avisar(await msgErro(error), "erro");
        box.remove(); avisar("Obrigado pelo retorno!", "ok"); await contarRespostas(); montarMenu();
      });
      el.prepend(box);
    }
  }

  // ── telas ────────────────────────────────────────────────────────────────
  const TELAS = {};

  TELAS.apresentacao = async (el) => {
    el.innerHTML = `
      <h1 class="chamada-marca">Quem junta,<br>vende.</h1>
      <p style="font-size:1.2rem;line-height:1.5;max-width:36em">Anuncie sua sucata sem pôr preço. Os ferros-velhos e recicladoras perto de você mandam uma oferta que <b>só você vê</b>, e você aceita a melhor.</p>
      <div class="passos">
        <div class="passo"><span class="num-placa" aria-hidden="true">1</span><h3>Anuncie o que juntou</h3><p class="suave">Toque nos materiais, diga o peso aproximado e tire uma foto. Leva um minuto.</p></div>
        <div class="passo"><span class="num-placa" aria-hidden="true">2</span><h3>Receba ofertas de quem está perto</h3><p class="suave">Cada comprador manda a oferta só para você. Nenhum vê a oferta do outro, e você vê se está acima ou abaixo do preço da região.</p></div>
        <div class="passo"><span class="num-placa" aria-hidden="true">3</span><h3>Aceite a melhor e combine</h3><p class="suave">Seu telefone só aparece para quem você aceitar. Pesem na balança e recebam o combinado.</p></div>
      </div>
      <div class="cartao"><h3>Quer vender agora mesmo?</h3>
        <p class="suave">Digite seu CEP e veja no mapa quem compra perto de você, com horário e WhatsApp.</p></div>
      <div class="cartao"><h3>É comprador (ferro-velho, depósito, recicladora)?</h3>
        <p class="suave">Cadastre a empresa pelo CNPJ, veja os anúncios perto e anuncie o que você compra: quem vende perto acha você. Grátis no lançamento.</p></div>
      <p class="suave">Começamos pela região de Salto/SP (até 50 km: Itu, Indaiatuba, Sorocaba, Jundiaí, Campinas). Fora dela, você entra na lista de espera.</p>
      <div class="acoes">
        <a class="btn btn-primario" href="#/anuncios">Ver os anúncios</a>
        ${estado.sessao ? "" : `<a class="btn btn-secundario" href="#/entrar">Entrar ou criar cadastro</a>`}
      </div>`;
  };

  TELAS.entrar = async (el) => {
    if (estado.sessao) return ir(telaInicial());
    el.innerHTML = `
      <h1>Entrar ou criar cadastro</h1>
      <p>Ver os anúncios é livre. O cadastro é para fazer negócio: anunciar, mandar oferta e ver o WhatsApp. É grátis.</p>
      <p class="suave">Mandamos um código por SMS para o seu celular. Não precisa de senha.</p>
      <div class="cartao" id="passo-tel">
        <label for="tel">Seu celular com DDD</label>
        <input type="tel" id="tel" inputmode="numeric" autocomplete="tel-national" placeholder="(11) 99999-9999">
        <div class="acoes"><button class="btn btn-primario" id="btn-codigo">Receber código</button></div>
      </div>
      <div class="cartao oculto" id="passo-cod">
        <label for="cod">Código que chegou por SMS</label>
        <input type="text" id="cod" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
        <div class="acoes"><button class="btn btn-primario" id="btn-entrar">Entrar</button>
        <button class="btn btn-secundario" id="btn-voltar">Trocar o número</button></div>
      </div>
      <p><a href="#/${esc(lerVolta() && PUBLICAS.has(lerVolta()) ? lerVolta() : "anuncios")}">← Voltar aos anúncios</a></p>`;
    const tel = $("#tel", el);
    tel.addEventListener("input", () => (tel.value = fmtTel(tel.value)));
    let fone = null;
    $("#btn-codigo", el).addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
      const d = digitos(tel.value);
      if (d.length < 10 || d.length > 11) throw new Error("Confira o número: DDD + celular.");
      fone = `+55${d}`;
      const { error } = await sb.auth.signInWithOtp({ phone: fone });
      if (error) throw new Error(/provider|disabled|not enabled/i.test(error.message)
        ? "O login por telefone ainda não foi ligado. Fale com o Luiz." : error.message);
      $("#passo-tel", el).classList.add("oculto"); $("#passo-cod", el).classList.remove("oculto"); $("#cod", el).focus();
    }));
    $("#btn-voltar", el).addEventListener("click", () => { $("#passo-cod", el).classList.add("oculto"); $("#passo-tel", el).classList.remove("oculto"); });
    $("#btn-entrar", el).addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
      const { data, error } = await sb.auth.verifyOtp({ phone: fone, token: digitos($("#cod", el).value), type: "sms" });
      if (error) throw new Error("Código errado ou vencido. Peça outro.");
      estado.sessao = data.session;
      await aoEntrar();
      ir(lerVolta() ?? telaInicial());
    }));
  };

  TELAS.papel = async (el) => {
    el.innerHTML = `
      <h1>Como você vai usar o Sucata Livre?</h1>
      <div class="grade">
        ${estado.vendedor ? "" : `<a class="cartao" href="#/cad-vendedor" style="text-decoration:none;color:inherit">
          <h3>Eu vendo material</h3><p class="suave">Catador ou sucateiro: quero anunciar e receber ofertas, ou saber quem compra perto.</p></a>`}
        ${estado.comprador ? "" : `<a class="cartao" href="#/cad-comprador" style="text-decoration:none;color:inherit">
          <h3>Eu compro material</h3><p class="suave">Ferro-velho, depósito ou recicladora com CNPJ: quero ver os anúncios perto.</p></a>`}
      </div>`;
  };

  TELAS["cad-vendedor"] = async (el) => {
    const v = estado.vendedor;
    let tipo = v?.tipo ?? "catador", cepOk = v?.cep ?? null;
    el.innerHTML = `
      <h1>${v ? "Meu cadastro" : "Cadastro de quem vende"}</h1>
      <div class="cartao">
        <div class="campos">
          <div><label for="nome">Seu nome</label><input type="text" id="nome" autocomplete="name" value="${esc(estado.eu?.nome ?? "")}"></div>
          <div><label for="cpf">CPF</label><input type="text" id="cpf" inputmode="numeric" placeholder="000.000.000-00" ${v ? 'disabled value="já cadastrado"' : ""}>
            <span class="dica">Só a equipe do Sucata Livre vê. Serve para dar segurança a todos.</span></div>
        </div>
        <h2>Você é…</h2>
        <div class="chips" id="tipo">
          <button type="button" class="chip" data-v="catador">Catador</button>
          <button type="button" class="chip" data-v="sucateiro">Sucateiro</button>
        </div>
        <h2>Onde você fica</h2>
        <div class="campos"><div><label for="cep">CEP</label>
          <input type="text" id="cep" inputmode="numeric" placeholder="00000-000" value="${esc(v ? fmtCEP(v.cep) : "")}" ${v ? "disabled" : ""}>
          <span class="dica" id="cep-info">${v ? esc(PRECISAO[v.precisao_geo] ?? "") : "Não sabe? Procure “CEP + nome da sua rua” na internet."}</span></div></div>
        ${v ? "" : `<p style="margin-top:18px"><label class="check"><input type="checkbox" id="termo">
          <span>Aceito o termo de uso e declaro que só vendo material de origem lícita.</span></label></p>`}
        <div class="acoes"><button class="btn btn-primario" id="salvar">${v ? "Salvar" : "Criar meu cadastro"}</button></div>
      </div>`;
    const marcar = (valor) => $$(`#tipo .chip`, el).forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.v === valor)));
    marcar(tipo);
    $("#tipo", el).addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) marcar((tipo = c.dataset.v)); });
    const cpf = $("#cpf", el); if (!v) cpf.addEventListener("input", () => (cpf.value = fmtCPF(cpf.value)));
    const cep = $("#cep", el), info = $("#cep-info", el);
    if (!v) cep.addEventListener("input", async () => {
      cep.value = fmtCEP(cep.value); cepOk = null;
      const d = digitos(cep.value);
      if (d.length !== 8) return;
      info.textContent = "Procurando…";
      try {
        const r = await consultarCep(d), g = r.geo;
        cepOk = d;
        info.innerHTML = `📍 ${esc([g.logradouro, g.bairro, `${g.cidade}/${g.uf}`].filter(Boolean).join(", "))} · ${esc(PRECISAO[g.precisao])}`
          + (r.na_regiao ? "" : `<br><b>Ainda não chegamos em ${esc(g.cidade)}. Você vai para a lista de espera.</b>`);
      } catch (e) { info.textContent = e.message; avisar(e.message, "erro"); }
    });
    $("#salvar", el).addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
      if (v) { avisar("Para mudar o CEP ou o tipo, fale com a gente pelo 💬.", "info"); return; }
      if (!cepOk) throw new Error("Digite um CEP válido e espere aparecer o endereço.");
      const { data, error } = await sb.rpc("slv_cadastrar_vendedor", {
        p_nome: $("#nome", el).value, p_cpf: cpf.value, p_cep: cepOk, p_tipo: tipo,
        p_raio: Number(estado.params.raio_desloc_padrao_km ?? 5), p_aceito: $("#termo", el).checked,
      });
      if (error) throw error;
      if (data.status === "fora_regiao") {
        el.innerHTML = `<div class="cartao alerta"><h1>Ainda não chegamos em ${esc(data.cidade)}/${esc(data.uf)}</h1>
          <p>Você está na lista de espera. Avisamos pelo seu celular quando o Sucata Livre abrir aí.</p></div>`;
        return;
      }
      estado.local = null;
      await carregarPerfil(); avisar("Cadastro feito! 🎉", "ok"); ir(lerVolta() ?? "quem-compra");
    }));
  };

  // ── quem vende: quem compra perto ───────────────────────────────────────
  TELAS["quem-compra"] = async (el) => {
    await carregarCatalogo();
    const M = MAT();
    const l = estado.local;
    // 1º os anúncios de compra; se não houver nenhum perto, os compradores cadastrados servem de reserva
    let lista = [], reserva = false;
    if (l) {
      const r = await sb.rpc("slv_procuras_perto", { p_lat: l.lat, p_lng: l.lng, p_raio_km: estado.raio, p_familia: estado.familiaFiltro });
      if (r.error) throw r.error;
      lista = r.data ?? [];
      if (!lista.length && estado.familiaFiltro == null) {
        const c = await sb.rpc("slv_compradores_perto", { p_lat: l.lat, p_lng: l.lng, p_raio_km: estado.raio });
        if (c.error) throw c.error;
        lista = (c.data ?? []).map((x) => ({ ...x, comprador_id: x.id, raio_busca_km: x.faz_coleta ? null : 0, reserva: true }));
        reserva = lista.length > 0;
      }
    }
    el.innerHTML = `
      ${lado("quem-compra")}
      ${caixaCep("Quem compra sucata perto de você?")}
      ${filtrosHTML()}
      <div class="cartao chamada"><h3>Tem material parado? Anuncie em 1 minuto</h3>
        <p>Diga o que tem e quanto pesa. Os compradores perto mandam a oferta só para você, e você escolhe a melhor.</p>
        <div class="acoes"><a class="btn btn-primario" href="#/anunciar">Anunciar meu material</a></div></div>
      <div class="duas">
        <section>
          <h2>${lista.length} comprador${lista.length === 1 ? "" : "es"} até ${estado.raio} km <small class="suave">${reserva ? "cadastrados (ainda sem anúncio de compra)" : "anúncios de compra"}</small></h2>
          ${avisoExemplos(lista)}
          ${lista.length ? `<div class="lista-compra">${lista.map((c, i) => { const ab = abertoAgora(c.horario); return `
            <article class="cartao comprador"><div class="comprador-topo"><span class="pino">${i + 1}</span>
              <div class="cn"><span class="tags">${c.reserva ? "" : `<span class="etiqueta compra">Compra</span>`}${c.exemplo ? `<span class="etiqueta exemplo">Exemplo</span>` : ""}</span><h3>${esc(c.nome)}</h3><span class="suave">${esc([c.bairro, c.cidade].filter(Boolean).join(", "))}</span></div>
              <span class="km">≈ ${km(c.distancia_km)} km</span></div>
              <div class="cods" aria-label="Compra ${esc(nomesMateriais(c.materiais))}">${(c.materiais ?? []).map(selo).join("")}</div>
              ${c.observacao ? `<p class="suave">“${esc(c.observacao)}”</p>` : ""}
              <div class="tags">${ab === null ? "" : `<span class="etiqueta ${ab ? "ok" : "ruim"}">${ab ? "Aberto agora" : "Fechado agora"}</span>`}
                ${c.reserva ? (c.faz_coleta ? `<span class="etiqueta">Busca no local</span>` : "") : Number(c.raio_busca_km) > 0 ? `<span class="etiqueta">Busca até ${String(c.raio_busca_km).replace(".0", "")} km</span>` : `<span class="etiqueta">Só no balcão</span>`}
                ${Number(c.minimo_kg) > 0 ? `<span class="etiqueta">Mínimo ${String(c.minimo_kg).replace(".0", "")} kg</span>` : ""}
                ${c.paga_pix ? `<span class="etiqueta">Paga no Pix na hora</span>` : ""}
                ${c.horario?.seg_sex ? `<span class="etiqueta">seg a sex ${esc(c.horario.seg_sex.abre)} às ${esc(c.horario.seg_sex.fecha)}</span>` : ""}</div>
              <div class="contato">${c.exemplo ? `<span class="suave">Exemplo: mostra como fica um anúncio de compra, sem WhatsApp.</span>`
                : `<button type="button" class="btn btn-secundario" ${c.reserva ? `data-contato="${c.comprador_id}"` : `data-procura="${c.id}"`}>Ver WhatsApp e endereço</button>`}</div>
            </article>`; }).join("")}</div>`
            : `<div class="cartao vazio">${l ? `Ninguém comprando esse material até ${estado.raio} km. Aumente a distância ou anuncie: os compradores da região veem o seu anúncio.` : "Digite seu CEP para ver quem compra perto."}</div>`}
        </section>
        ${l && lista.length ? `<section><h2>No mapa</h2>${mapaHTML(lista, "m-comp")}
          <p class="legenda"><span class="ponto m-eu-l"></span>você <span class="ponto m-comp-l"></span>quem compra (número = lista)</p>${tabelaReferencia()}</section>` : l ? `<section>${tabelaReferencia()}</section>` : ""}
      </div>`;
    ligarCaixaCep(el);
    ligarFiltros(el);
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-contato], [data-procura]"); if (!b) return;
      if (!precisa("vendedor", "quem-compra")) return;
      ocupado(b, async () => {
        const { data: ct, error: er } = b.dataset.procura
          ? await sb.rpc("slv_contato_procura", { p_procura: Number(b.dataset.procura) })
          : await sb.rpc("slv_contato_comprador", { p_comprador: b.dataset.contato });
        if (er) throw er;
        b.parentElement.innerHTML = `<div class="zap">WhatsApp: <b>${esc(ct.telefone ? fmtTel(ct.telefone) : "não informado")}</b>
          <span class="suave">${esc([ct.endereco, ct.bairro, ct.cidade].filter(Boolean).join(", "))}. Pergunte o preço de hoje.</span></div>`;
      });
    });
  };

  // ── quem vende: anunciar em 3 passos ────────────────────────────────────
  TELAS.anunciar = async (el) => {
    if (!precisa("vendedor", "anunciar")) return;
    await carregarCatalogo();
    const R = { passo: 1, itens: {}, fotos: [], cep: estado.vendedor.cep, geo: null, pode_buscar: true, risco: null, declarou: false };
    const { data: riscos } = await sb.from("slv_itens_risco").select("*").order("id");
    const M = MAT();

    function desenhar() {
      const cab = `<div class="passos-barra" aria-label="Passo ${R.passo} de 3">${[1, 2, 3].map((i) => `<span class="${i <= R.passo ? "on" : ""}"></span>`).join("")}</div>
        <h1>${["O que você tem?", "Quanto, mais ou menos?", "Onde está o material?"][R.passo - 1]}</h1>`;
      if (R.passo === 1) {
        const comRisco = Object.keys(R.itens).map(Number).filter((id) => M[id]?.pede_check_risco);
        el.innerHTML = cab + `<p class="suave">Toque em tudo o que você juntou. Pode escolher mais de um.</p>
          ${estado.familias.map((f) => `<div class="familia"><h2>${esc(f.icone)} ${esc(f.nome)}</h2><div class="materiais">
            ${estado.materiais.filter((m) => m.familia_id === f.id).map((m) =>
              `<button type="button" class="material" data-mat="${m.id}" aria-pressed="${m.id in R.itens}">${selo(m.id)}${esc(m.nome)}</button>`).join("")}
          </div></div>`).join("")}
          ${comRisco.length ? `<div class="cartao alerta"><h3>Tem algum destes no meio?</h3>
            <p class="suave">${esc((riscos ?? []).map((r) => r.nome).join(" · "))}</p>
            <div class="chips"><button type="button" class="chip" data-risco="nao" aria-pressed="${R.risco === false}">Não tem nenhum</button>
              <button type="button" class="chip" data-risco="sim" aria-pressed="${R.risco === true}">Tem, sim</button></div>
            ${R.risco ? `<p style="margin-top:12px"><label class="check"><input type="checkbox" id="declaro" ${R.declarou ? "checked" : ""}>
              <span>Declaro que o material tem origem lícita. O comprador vê que o anúncio tem declaração de origem.</span></label></p>` : ""}</div>` : ""}
          <div class="acoes"><button type="button" class="btn btn-primario" data-ir="2">Continuar</button></div>`;
      } else if (R.passo === 2) {
        el.innerHTML = cab + `<p class="suave">Não precisa ser exato. O comprador confere na balança.</p>
          <div class="cartao">${Object.keys(R.itens).map((id) => `<div class="linha-preco"><span class="ico">${selo(id)}</span>
            <label for="kg${id}" style="margin:0">${esc(M[id].nome)}</label>
            <span class="kg"><input type="text" id="kg${id}" data-kg="${id}" inputmode="decimal" value="${R.itens[id] || ""}" placeholder="0"></span></div>`).join("")}
            <div class="estimativa" id="estimativa">${textoEstimativa(itensR())}</div></div>
          <div class="cartao"><h3>Fotos do material <small class="suave">(até 3, opcional)</small></h3>
            <p class="suave">Anúncio com foto recebe mais ofertas.</p>
            <div class="anexos">${R.fotos.map((f) => `<img src="${f.url}" alt="Foto do material">`).join("")}</div>
            ${R.fotos.length < 3 ? `<label class="btn btn-secundario" style="margin-top:10px">Tirar ou escolher foto<input type="file" id="foto" accept="image/*" multiple hidden></label>` : ""}</div>
          <div class="acoes"><button type="button" class="btn btn-secundario" data-ir="1">Voltar</button><button type="button" class="btn btn-primario" data-ir="3">Continuar</button></div>`;
      } else {
        el.innerHTML = cab + `<div class="cartao"><div class="campos"><div><label for="cep-an">CEP de onde está o material</label>
            <input type="text" id="cep-an" inputmode="numeric" value="${esc(fmtCEP(R.cep))}">
            <span class="dica" id="cep-an-info">${R.geo ? `📍 ${esc([R.geo.bairro, R.geo.cidade].filter(Boolean).join(", "))}` : "Já vem com o CEP do seu cadastro."}</span></div></div>
          <h2>O comprador pode buscar?</h2>
          <div class="chips"><button type="button" class="chip" data-busca="1" aria-pressed="${R.pode_buscar}">Sim, venham buscar</button>
            <button type="button" class="chip" data-busca="0" aria-pressed="${!R.pode_buscar}">Não, eu levo</button></div>
          <p class="suave" style="margin-top:12px">Seu telefone não aparece no anúncio. Só o comprador cuja oferta você aceitar vê o seu WhatsApp.</p></div>
          <div class="cartao"><h3>Resumo</h3><p>${esc(tituloItens(Object.entries(R.itens).filter(([, v]) => v > 0).map(([id, v]) => ({ material_id: Number(id), peso_kg: v }))))}</p>
            <p class="suave">${R.fotos.length} foto${R.fotos.length === 1 ? "" : "s"}${R.risco ? " · com declaração de origem" : ""}</p>
            <div class="estimativa">${textoEstimativa(itensR())}</div></div>
          <div class="acoes"><button type="button" class="btn btn-secundario" data-ir="2">Voltar</button><button type="button" class="btn btn-primario" id="publicar">Publicar anúncio</button></div>`;
        const c = $("#cep-an", el);
        c.addEventListener("input", async () => {
          c.value = fmtCEP(c.value); const d = digitos(c.value); R.cep = d; R.geo = null;
          if (d.length !== 8) return;
          const info = $("#cep-an-info", el); info.textContent = "Procurando…";
          try { const r = await consultarCep(d); R.geo = r.geo; info.textContent = `📍 ${[r.geo.bairro, r.geo.cidade].filter(Boolean).join(", ")}${r.na_regiao ? "" : " · fora da região de lançamento"}`; }
          catch (e) { info.textContent = e.message; }
        });
      }
    }
    const guardarPesos = () => $$("[data-kg]", el).forEach((i) => (R.itens[i.dataset.kg] = lerKg(i.value)));
    function itensR() { return Object.entries(R.itens).map(([id, v]) => ({ material_id: Number(id), peso_kg: Number(v) || 0 })); }
    // estimativa ao vivo enquanto a pessoa digita o peso
    el.addEventListener("input", (e) => {
      if (!e.target.dataset.kg) return;
      guardarPesos();
      const box = $("#estimativa", el); if (box) box.innerHTML = textoEstimativa(itensR());
    });

    el.addEventListener("click", (e) => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.dataset.mat) { const id = t.dataset.mat; if (id in R.itens) delete R.itens[id]; else R.itens[id] = 0; desenhar(); return; }
      if (t.dataset.risco) { R.risco = t.dataset.risco === "sim"; if (!R.risco) R.declarou = false; desenhar(); return; }
      if (t.dataset.busca) { R.pode_buscar = t.dataset.busca === "1"; desenhar(); return; }
      if (t.dataset.ir) {
        const para = Number(t.dataset.ir);
        if (R.passo === 2) guardarPesos();
        if (para === 2 && R.passo === 1) {
          if (!Object.keys(R.itens).length) return avisar("Toque em pelo menos um material.", "erro");
          const temRisco = Object.keys(R.itens).some((id) => M[id]?.pede_check_risco);
          if (temRisco && R.risco === null) return avisar("Responda se tem algum desses itens no meio.", "erro");
          if (R.risco && !R.declarou) return avisar("Marque a declaração de origem para continuar.", "erro");
        }
        if (para === 3 && !Object.values(R.itens).some((v) => v > 0)) return avisar("Coloque o peso de pelo menos um material.", "erro");
        R.passo = para; desenhar(); scrollTo(0, 0); return;
      }
      if (t.id === "publicar") ocupado(t, async () => {
        if (digitos(R.cep).length !== 8) throw new Error("Digite o CEP de onde está o material.");
        if (digitos(R.cep) !== estado.vendedor.cep && !R.geo) await consultarCep(digitos(R.cep));
        const caminhos = [];
        for (const [i, f] of R.fotos.entries()) {
          const ext = (f.file.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
          const caminho = `${estado.sessao.user.id}/${Date.now()}-${i + 1}.${ext}`;
          const { error } = await sb.storage.from("slv-anuncios").upload(caminho, f.file, { contentType: f.file.type });
          if (!error) caminhos.push(caminho);
        }
        const itens = Object.entries(R.itens).filter(([, v]) => v > 0).map(([id, v]) => ({ material_id: Number(id), peso_kg: v }));
        const { error } = await sb.rpc("slv_publicar_anuncio", { p_itens: itens, p_cep: digitos(R.cep), p_pode_buscar: R.pode_buscar, p_fotos: caminhos, p_item_risco: !!R.risco });
        if (error) throw error;
        avisar("Anúncio publicado. Os compradores perto já podem ver e mandar oferta.", "ok");
        ir("meus-anuncios");
      });
    });
    el.addEventListener("change", (e) => {
      if (e.target.id === "declaro") { R.declarou = e.target.checked; return; }
      if (e.target.id === "foto") {
        guardarPesos();
        for (const file of [...e.target.files].slice(0, 3 - R.fotos.length)) {
          if (file.size > 6 * 1024 * 1024) { avisar("Foto grande demais (máximo 6 MB).", "erro"); continue; }
          R.fotos.push({ file, url: URL.createObjectURL(file) });
        }
        desenhar();
      }
    });
    desenhar();
  };

  // ── quem vende: meus anúncios e ofertas recebidas ───────────────────────
  const SIT_ANUNCIO = { publicado: ["No ar", "ok"], vendido: ["Vendido", "dinheiro"], retirado: ["Retirado", ""], expirado: ["Expirou", "atencao"] };
  TELAS["meus-anuncios"] = async (el) => {
    if (!estado.vendedor) return ir("cad-vendedor");
    await carregarCatalogo();
    const { data, error } = await sb.rpc("slv_meus_anuncios");
    if (error) throw error;
    const lista = data ?? [];
    el.innerHTML = `<h1>Meus anúncios</h1>
      <p class="suave">Cada comprador vê só a própria oferta. Você vê todas.</p>
      <div class="acoes" style="margin-bottom:16px"><a class="btn btn-secundario" href="#/anunciar">Anunciar outro material</a></div>
      ${lista.length ? `<div class="lista">${lista.map((a) => `
        <article class="cartao" data-anuncio="${a.id}">
          <div class="cab"><h3>${esc(tituloItens(a.itens))}</h3><span class="etiqueta ${SIT_ANUNCIO[a.status][1]}">${SIT_ANUNCIO[a.status][0]}</span></div>
          <p class="suave">${esc([a.bairro, a.cidade].filter(Boolean).join(", "))} · publicado ${ha(a.criado_em)}${a.status === "publicado" ? ` · sai do ar ${new Date(a.expira_em).toLocaleDateString("pt-BR")}` : ""}</p>
          <p>${a.ofertas ? `${a.ofertas} oferta${a.ofertas > 1 ? "s" : ""} · melhor: <b class="valor">${reais(a.melhor_oferta)}</b>` : `<span class="suave">Ainda sem ofertas.</span>`}</p>
          <div class="ofertas-lugar"></div>
          <div class="acoes"><button type="button" class="btn btn-secundario" data-ver="${a.id}">${a.ofertas ? "Ver ofertas" : "Atualizar"}</button>
            ${a.status === "publicado" ? `<button type="button" class="btn btn-perigo" data-retirar="${a.id}">Retirar anúncio</button>` : ""}</div>
        </article>`).join("")}</div>`
        : `<div class="cartao vazio">Você ainda não anunciou nada.</div>`}`;

    async function verOfertas(card, id) {
      const { data: of, error: er } = await sb.rpc("slv_ofertas_do_anuncio", { p_anuncio: id });
      if (er) throw er;
      const publicado = !card.querySelector("[data-retirar]") ? false : true;
      const itensAnuncio = lista.find((x) => x.id === id)?.itens;
      card.querySelector(".ofertas-lugar").innerHTML = `<div class="estimativa">${textoEstimativa(itensAnuncio)}</div>` + ((of ?? []).length ? `<div class="lista">${of.map((o) => `
        <div class="oferta ${o.status === "aceita" ? "aceita" : ""}"><div class="cab"><div><b>${esc(o.comprador_nome)}</b><br>
          <small class="suave">≈ ${km(o.distancia_km)} km · ${o.faz_coleta ? "busca no local" : "você leva"} · ${ha(o.atualizado_em)}</small></div>
          <span class="valor">${reais(o.valor)}</span></div>
          <div>${selloOferta(Number(o.valor), itensAnuncio)}</div>
          ${o.status === "aceita" ? `<div class="zap">Oferta aceita. WhatsApp do comprador: <b>${esc(o.telefone ? fmtTel(o.telefone) : "não informado")}</b><span class="suave">Combine a retirada e a pesagem.</span></div>`
            : o.status === "nao_aceita" ? `<small class="suave">Não aceita</small>`
            : publicado ? `<div class="acoes"><button type="button" class="btn btn-primario" data-aceitar="${o.id}">Aceitar esta oferta</button></div>` : ""}</div>`).join("")}</div>`
        : `<p class="suave">Ainda sem ofertas. Os compradores perto já veem o seu anúncio.</p>`);
    }

    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const card = b.closest("[data-anuncio]");
      if (b.dataset.ver) ocupado(b, () => verOfertas(card, Number(b.dataset.ver)));
      if (b.dataset.retirar) {
        if (b.dataset.confirmar !== "1") { b.dataset.confirmar = "1"; b.textContent = "Toque de novo para retirar"; return; }
        ocupado(b, async () => { const { error: er } = await sb.rpc("slv_retirar_anuncio", { p_anuncio: Number(b.dataset.retirar) }); if (er) throw er; avisar("Anúncio retirado.", "ok"); ir("meus-anuncios"); window.Acomp.desfez("anuncio"); });
      }
      // aceitar fecha o negócio e não volta atrás: pede um segundo toque
      if (b.dataset.aceitar && b.dataset.confirmar !== "1") { b.dataset.confirmar = "1"; b.textContent = "Toque de novo para confirmar"; b.classList.replace("btn-primario", "btn-secundario"); return; }
      if (b.dataset.aceitar) ocupado(b, async () => {
        const { data: ct, error: er } = await sb.rpc("slv_aceitar_oferta", { p_oferta: Number(b.dataset.aceitar) });
        if (er) throw er;
        avisar(`Oferta de ${reais(ct.valor)} aceita. Combine com ${ct.nome} pelo WhatsApp.`, "ok");
        await verOfertas(card, Number(card.dataset.anuncio));
        card.querySelector("[data-retirar]")?.remove();
        card.querySelector(".cab .etiqueta").outerHTML = `<span class="etiqueta dinheiro">Vendido</span>`;
      });
    });
    if (lista[0]?.ofertas) await verOfertas(el.querySelector(`[data-anuncio="${lista[0].id}"]`), lista[0].id);
  };

  // ── quem compra ──────────────────────────────────────────────────────────
  TELAS["cad-comprador"] = async (el) => {
    const c = estado.comprador;
    const h = c?.horario ?? {};
    el.innerHTML = `
      <h1>${c ? "Minha empresa" : "Cadastro de comprador"}</h1>
      <div class="cartao">
        <div class="campos"><div><label for="cnpj">CNPJ da empresa</label>
          <input type="text" id="cnpj" inputmode="numeric" placeholder="00.000.000/0000-00" value="${esc(c ? fmtCNPJ(c.cnpj) : "")}" ${c ? "disabled" : ""}></div></div>
        ${c ? "" : `<div class="acoes"><button class="btn btn-secundario" id="consultar">Consultar na Receita</button></div>`}
        <div id="receita"></div>
      </div>
      <div class="cartao ${c ? "" : "oculto"}" id="resto">
        <div class="campos">
          <div><label for="nome">Seu nome (quem vai usar o app)</label><input type="text" id="nome" value="${esc(estado.eu?.nome ?? "")}"></div>
          <div><label for="telc">WhatsApp da empresa</label><input type="tel" id="telc" inputmode="numeric" value="${esc(c?.telefone_comercial ? fmtTel(c.telefone_comercial) : "")}">
            <span class="dica">Aparece para quem vende quando toca em "Ver WhatsApp" e quando você tem a oferta aceita.</span></div>
          <div><label for="numero">Número do endereço</label><input type="text" id="numero" value="${esc(c?.numero ?? "")}"></div>
        </div>
        <h2>Horário de funcionamento</h2>
        <div class="campos">
          <div><label>Segunda a sexta</label><div class="chips"><input type="time" id="ss-a" value="${esc(h.seg_sex?.abre ?? "08:00")}"><input type="time" id="ss-f" value="${esc(h.seg_sex?.fecha ?? "18:00")}"></div></div>
          <div><label>Sábado <small>(deixe vazio se fecha)</small></label><div class="chips"><input type="time" id="sa-a" value="${esc(h.sab?.abre ?? "08:00")}"><input type="time" id="sa-f" value="${esc(h.sab?.fecha ?? "12:00")}"></div></div>
        </div>
        <p style="margin-top:16px"><label class="check"><input type="checkbox" id="coleta" ${c?.faz_coleta ? "checked" : ""}><span>Busco material no local de quem vende</span></label></p>
        ${c ? "" : `<p><label class="check"><input type="checkbox" id="termo"><span>Aceito o termo de uso e me comprometo a pagar a oferta que fizer, conferindo o peso na balança.</span></label></p>`}
        <div class="acoes"><button class="btn btn-primario" id="salvar">${c ? "Salvar" : "Criar cadastro"}</button></div>
      </div>`;
    const cnpj = $("#cnpj", el), tel = $("#telc", el);
    cnpj.addEventListener("input", () => (cnpj.value = fmtCNPJ(cnpj.value)));
    tel.addEventListener("input", () => (tel.value = fmtTel(tel.value)));
    let consulta = null;
    const horario = () => {
      const ss = { abre: $("#ss-a", el).value, fecha: $("#ss-f", el).value };
      const sa = $("#sa-a", el).value && $("#sa-f", el).value ? { abre: $("#sa-a", el).value, fecha: $("#sa-f", el).value } : null;
      return { seg_sex: ss, sab: sa, dom: null };
    };

    $("#consultar", el)?.addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
      const { data, error } = await sb.functions.invoke("slv-comprador", { body: { acao: "consultar", cnpj: digitos(cnpj.value) } });
      if (error) throw new Error(await msgErro(error));
      consulta = data;
      $("#receita", el).innerHTML = `
        <div class="cartao ${data.aprovacao === "auto" ? "destaque" : "alerta"}" style="margin-top:16px">
          <h3>${esc(data.nome_fantasia || data.razao_social)}</h3>
          <p class="suave">${esc(data.razao_social)}<br>${esc([data.endereco, data.numero, data.bairro].filter(Boolean).join(", "))} · ${esc(data.cidade)}/${esc(data.uf)} · CEP ${esc(fmtCEP(data.cep))}</p>
          <p>Atividade: ${esc(data.cnae_principal)} ${esc(data.cnae_principal_descricao ?? "")} · Situação: ${esc(data.situacao)}</p>
          ${data.aprovacao === "auto"
            ? `<p><b>Tudo certo: o cadastro é aprovado na hora.</b></p>`
            : `<p><b>O cadastro vai para análise da nossa equipe:</b></p><ul>${data.motivos.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`}
        </div>`;
      if (!$("#numero", el).value && data.numero) $("#numero", el).value = data.numero;
      $("#resto", el).classList.remove("oculto");
    }));

    $("#salvar", el).addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
      if (c) {
        const { error } = await sb.from("slv_compradores").update({
          telefone_comercial: digitos(tel.value) || null, numero: $("#numero", el).value || null,
          horario: horario(), faz_coleta: $("#coleta", el).checked,
        }).eq("usuario_id", c.usuario_id);
        if (error) throw error;
        await carregarPerfil(); avisar("Salvo!", "ok"); return;
      }
      if (!consulta) throw new Error("Consulte o CNPJ primeiro.");
      let dica = null;
      try {
        const r = await fetch(`https://cep.awesomeapi.com.br/json/${digitos(consulta.cep)}`);
        if (r.ok) { const d = await r.json(); if (d.lat) dica = { lat: Number(d.lat), lng: Number(d.lng) }; }
      } catch {}
      const { data, error } = await sb.functions.invoke("slv-comprador", { body: {
        acao: "salvar", cnpj: digitos(cnpj.value), nome: $("#nome", el).value, telefone_comercial: digitos(tel.value),
        numero: $("#numero", el).value, horario: horario(), faz_coleta: $("#coleta", el).checked, aceito: $("#termo", el).checked, dica,
      } });
      if (error) throw new Error(await msgErro(error));
      estado.local = null;
      await carregarPerfil();
      avisar(data.status === "aprovado" ? "Cadastro aprovado! 🎉" : "Cadastro enviado para análise.", "ok");
      ir(data.status === "aprovado" ? (lerVolta() ?? "o-que-compro") : "inicio-comprador");
    }));
  };

  TELAS["inicio-comprador"] = async (el) => {
    const c = estado.comprador;
    if (!c) return ir("cad-comprador");
    const status = {
      aprovado: `<div class="cartao destaque"><h3>Cadastro aprovado</h3><p>Você já vê os anúncios perto e pode mandar ofertas.</p></div>`,
      pendente: `<div class="cartao alerta"><h3>Cadastro em análise</h3><p>${esc(c.motivo_status ?? "")}</p><p class="suave">A nossa equipe confere e avisa você. Enquanto isso, já dá para marcar o que você compra.</p></div>`,
      recusado: `<div class="cartao erro"><h3>Cadastro não aprovado</h3><p>${esc(c.motivo_status ?? "")}</p><p class="suave">Se acha que é engano, fale com a gente pelo 💬.</p></div>`,
      suspenso: `<div class="cartao erro"><h3>Cadastro suspenso</h3><p>${esc(c.motivo_status ?? "")}</p></div>`,
    }[c.status];
    el.innerHTML = `
      <h1>${esc(c.nome_fantasia || c.razao_social)}</h1>
      <p class="suave">${esc(c.cidade)}/${esc(c.uf)} · ${esc(PRECISAO[c.precisao_geo] ?? "")}</p>
      ${status}
      <div class="grade">
        <a class="cartao" href="#/anuncios" style="text-decoration:none;color:inherit"><h3>Anúncios perto</h3><p class="suave">Material à venda perto da sua empresa.</p></a>
        <a class="cartao" href="#/minhas-ofertas" style="text-decoration:none;color:inherit"><h3>Minhas ofertas</h3><p class="suave">O que você ofereceu e o que foi aceito.</p></a>
        <a class="cartao" href="#/anunciar-compra" style="text-decoration:none;color:inherit"><h3>Anunciar que compro</h3><p class="suave">Quem vende perto acha você e chama no WhatsApp.</p></a>
        <a class="cartao" href="#/minhas-procuras" style="text-decoration:none;color:inherit"><h3>Meus anúncios de compra</h3><p class="suave">Quantos pediram o seu WhatsApp.</p></a>
        <a class="cartao" href="#/o-que-compro" style="text-decoration:none;color:inherit"><h3>O que compro</h3><p class="suave">Aparece para quem vende quando procura comprador.</p></a>
        <a class="cartao" href="#/cad-comprador" style="text-decoration:none;color:inherit"><h3>Dados da empresa</h3><p class="suave">WhatsApp, horário e coleta.</p></a>
      </div>`;
  };

  TELAS["o-que-compro"] = async (el) => {
    const c = estado.comprador;
    if (!c) return ir("cad-comprador");
    await carregarCatalogo();
    const { data: fams } = await sb.from("slv_comprador_familias").select("*").eq("comprador_id", c.usuario_id);
    const marcadas = new Set((fams ?? []).map((f) => f.familia_id));
    el.innerHTML = `
      <h1>O que você compra</h1>
      <p class="suave">Quem vende vê isso quando procura comprador perto.</p>
      <div class="lista">
      ${estado.familias.map((f) => `
        <label class="cartao check" data-fam="${f.id}"><input type="checkbox" class="compra" ${marcadas.has(f.id) ? "checked" : ""}>
          <span><b>${esc(f.icone)} ${esc(f.nome)}</b><br><small class="suave">${esc(estado.materiais.filter((m) => m.familia_id === f.id).map((m) => m.nome).join(" · "))}</small></span></label>`).join("")}
      </div>
      <div class="acoes"><button class="btn btn-primario" id="salvar">Salvar</button></div>`;
    $("#salvar", el).addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
      const marcar = [], tirar = [];
      for (const card of $$("[data-fam]", el)) {
        const id = Number(card.dataset.fam);
        if ($(".compra", card).checked) marcar.push({ comprador_id: c.usuario_id, familia_id: id });
        else if (marcadas.has(id)) tirar.push(id);
      }
      if (!marcar.length) throw new Error("Marque pelo menos uma família de material.");
      const r1 = await sb.from("slv_comprador_familias").upsert(marcar, { onConflict: "comprador_id,familia_id", ignoreDuplicates: true });
      if (r1.error) throw r1.error;
      if (tirar.length) {
        const r2 = await sb.from("slv_comprador_familias").delete().eq("comprador_id", c.usuario_id).in("familia_id", tirar);
        if (r2.error) throw r2.error;
      }
      avisar("Salvo!", "ok");
      ir(c.status === "aprovado" ? "anuncios" : "inicio-comprador");
    }));
  };

  TELAS.anuncios = async (el) => {
    const podeOfertar = estado.comprador?.status === "aprovado";
    await carregarCatalogo();
    const l = estado.local;
    const { data, error } = l ? await sb.rpc("slv_anuncios_perto", { p_lat: l.lat, p_lng: l.lng, p_raio_km: estado.raio, p_familia: estado.familiaFiltro })
      : { data: [] };
    if (error) throw error;
    const lista = data ?? [];
    const fotos = await urlsFotos(lista.map((a) => a.fotos?.[0]).filter(Boolean));
    let fi = 0; lista.forEach((a) => { if (a.fotos?.[0]) a._foto = fotos[fi++]; });
    el.innerHTML = `
      ${lado("anuncios")}
      ${caixaCep("Que sucata está à venda perto de você?")}
      ${filtrosHTML()}
      <div class="cartao chamada"><h3>Você compra sucata? Anuncie o que procura</h3>
        <p>Quem vende perto vê o seu anúncio de compra e chama você no WhatsApp.</p>
        <div class="acoes"><a class="btn btn-secundario" href="#/anunciar-compra">Anunciar que compro</a></div></div>
      <div class="duas">
        <section>
          <h2>${lista.length} anúncio${lista.length === 1 ? "" : "s"} até ${estado.raio} km <small class="suave">material à venda</small></h2>
          ${avisoExemplos(lista)}
          ${lista.length ? `<div class="grade-anuncios">${lista.map((a) => `
            <button type="button" class="anuncio" data-abrir="${a.id}">
              <span class="foto">${a._foto ? `<img src="${esc(a._foto)}" alt="">` : selosItens(a.itens)}<span class="dist">≈ ${km(a.distancia_km)} km</span></span>
              <span class="txt"><b>${esc(tituloItens(a.itens))}</b>
                <small class="suave">${esc([a.bairro, a.cidade].filter(Boolean).join(", "))} · ${ha(a.criado_em)}</small>
                ${(() => { const f = faixaItens(a.itens); return f ? `<small class="estima">Na região vale <b>${reais0(f[0])} a ${reais0(f[1])}</b></small>` : ""; })()}
                <span class="tags">${a.exemplo ? `<span class="etiqueta exemplo">Exemplo</span>` : ""}${a.pode_buscar ? `<span class="etiqueta ok">Pode buscar</span>` : `<span class="etiqueta">Leva até você</span>`}
                  ${a.tem_item_risco ? `<span class="etiqueta dinheiro">Com declaração de origem</span>` : ""}
                  ${a.minha_oferta ? `<span class="etiqueta">Sua oferta: ${reais(a.minha_oferta)}</span>` : ""}</span></span>
            </button>`).join("")}</div>`
            : `<div class="cartao vazio">${l ? "Nenhum anúncio desse material perto agora." : "Digite o CEP para ver os anúncios perto."}</div>`}
        </section>
        ${l && lista.length ? `<section><h2>No mapa</h2>${mapaHTML(lista, "m-anu")}
          <p class="legenda"><span class="ponto m-eu-l"></span>você <span class="ponto m-anu-l"></span>material à venda (número = lista)</p>
          ${podeOfertar ? "" : `<p class="suave" style="font-size:.9rem;margin-top:4px">O círculo em volta do número é a área aproximada. O endereço só aparece quando o negócio é fechado.</p>`}${tabelaReferencia()}</section>` : ""}
      </div>
      <div id="detalhe"></div>`;
    ligarCaixaCep(el);
    ligarFiltros(el);
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-abrir]"); if (!b) return;
      abrirAnuncio(lista.find((a) => String(a.id) === b.dataset.abrir));
    });

    async function abrirAnuncio(a) {
      const urls = await urlsFotos(a.fotos);
      const fundo = document.createElement("div");
      fundo.className = "modal-fundo";
      fundo.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="an-t">
        <div class="cab"><h2 id="an-t" style="margin:0">${esc(tituloItens(a.itens))}</h2><button type="button" class="btn-icone fechar" aria-label="Fechar">✕</button></div>
        ${urls.length ? `<div class="anexos">${urls.map((u) => `<img src="${esc(u)}" alt="Foto do material" class="foto-grande">`).join("")}</div>` : ""}
        <p class="suave">${esc([a.bairro, a.cidade].filter(Boolean).join(", "))} · ≈ ${km(a.distancia_km)} km · ${ha(a.criado_em)} · ${a.pode_buscar ? "pode buscar no local" : "quem vende leva até você"}</p>
        <p>Total: <b class="num">${String(totalKg(a.itens)).replace(".", ",")} kg</b>, conferidos na balança na hora.</p>
        <div class="estimativa">${textoEstimativa(a.itens)}</div>
        ${a.tem_item_risco ? `<div class="cartao alerta"><p>Quem vende marcou material de risco (fio, cabo ou peça de ferro) e declarou a origem. Confira antes de comprar.</p></div>` : ""}
        ${a.exemplo ? `<div class="cartao alerta"><h3>Anúncio de exemplo</h3><p>Ele mostra como fica um anúncio no Sucata Livre e não recebe oferta. Os anúncios de verdade aparecem sem esta marca.</p></div>
        <div class="acoes"><button type="button" class="btn btn-secundario fechar">Fechar</button></div>`
        : podeOfertar ? `<h3>Sua oferta</h3>
        <p class="suave">🔒 Só quem vende vê a sua oferta. Os outros compradores não veem.</p>
        <div class="campos"><div><label for="oferta">Quanto você paga por tudo? (R$)</label>
          <input type="text" id="oferta" inputmode="decimal" value="${a.minha_oferta && a.minha_situacao === "enviada" ? esc(String(a.minha_oferta).replace(".", ",")) : ""}" placeholder="Ex.: 180,00"></div></div>
        <div class="acoes"><button type="button" class="btn btn-primario" id="ofertar">${a.minha_oferta && a.minha_situacao === "enviada" ? "Mudar oferta" : "Enviar oferta"}</button>
          <button type="button" class="btn btn-secundario fechar">Fechar</button></div>`
        : `<h3>Quer comprar este material?</h3>
        <p class="suave">Ofertas são para ferro-velho, depósito e recicladora com CNPJ. O cadastro é grátis e a aprovação sai na hora pelo CNPJ. A sua oferta só quem vende vê.</p>
        <div class="acoes"><button type="button" class="btn btn-primario" id="quero-ofertar">${estado.sessao ? "Cadastrar minha empresa" : "Entrar para fazer oferta"}</button>
          <button type="button" class="btn btn-secundario fechar">Fechar</button></div>`}</div>`;
      document.body.appendChild(fundo);
      const fechar = () => fundo.remove();
      fundo.addEventListener("click", (e) => { if (e.target === fundo || e.target.closest(".fechar")) fechar(); });
      if (a.exemplo) return;
      if (!podeOfertar) { $("#quero-ofertar", fundo).addEventListener("click", () => { fechar(); precisa("comprador", "anuncios"); }); return; }
      $("#ofertar", fundo).addEventListener("click", (e) => ocupado(e.currentTarget, async () => {
        const v = lerReais($("#oferta", fundo).value);
        if (!v) throw new Error("Escreva quanto você paga, por exemplo 180,00.");
        const { error: er } = await sb.rpc("slv_ofertar", { p_anuncio: a.id, p_valor: v });
        if (er) throw er;
        fechar(); avisar("Oferta enviada. Só quem vende vê.", "ok"); rota();
      }));
      $("#oferta", fundo).focus();
    }
  };

  // ── quem compra: anúncio de compra ──────────────────────────────────────
  TELAS["anunciar-compra"] = async (el) => {
    if (!precisa("comprador", "anunciar-compra")) return;
    const c = estado.comprador;
    await carregarCatalogo();
    const { data: fams } = await sb.from("slv_comprador_familias").select("familia_id").eq("comprador_id", c.usuario_id);
    const famIds = new Set((fams ?? []).map((f) => f.familia_id));
    // começa marcado com o que a empresa já disse que compra
    const R = { mats: new Set(estado.materiais.filter((m) => famIds.has(m.familia_id)).map((m) => m.id)), raio: c.faz_coleta ? 10 : 0, minimo: 0, pix: true };
    function desenhar() {
      el.innerHTML = `
        <h1>Anunciar que compro</h1>
        <p class="suave">Quem vende perto vê o seu anúncio em "Quem compra perto" e chama no WhatsApp da empresa. Sem preço: o valor você combina na hora.</p>
        <div class="cartao">
          <h2 style="margin-top:0">O que você compra?</h2>
          ${estado.familias.map((f) => `<div class="familia"><h3>${esc(f.icone)} ${esc(f.nome)}</h3><div class="materiais">
            ${estado.materiais.filter((m) => m.familia_id === f.id).map((m) =>
              `<button type="button" class="material" data-mat="${m.id}" aria-pressed="${R.mats.has(m.id)}">${selo(m.id)}${esc(m.nome)}</button>`).join("")}
          </div></div>`).join("")}
          <h2>Você busca no local de quem vende?</h2>
          <div class="chips">${[0, 5, 10, 20, 30].map((r) => `<button type="button" class="chip" data-raio-b="${r}" aria-pressed="${R.raio === r}">${r ? `Até ${r} km` : "Não, só no balcão"}</button>`).join("")}</div>
          <h2>Peso mínimo para buscar</h2>
          <div class="chips">${[0, 20, 50, 100, 200].map((r) => `<button type="button" class="chip" data-minimo="${r}" aria-pressed="${R.minimo === r}">${r ? `${r} kg` : "Qualquer peso"}</button>`).join("")}</div>
          <p style="margin-top:16px"><label class="check"><input type="checkbox" id="pix" ${R.pix ? "checked" : ""}><span>Pago no Pix na hora</span></label></p>
          <div class="campos"><div><label for="obs">Recado curto <small class="suave">(opcional)</small></label>
            <input type="text" id="obs" maxlength="280" placeholder="Ex.: Compro cobre queimado com nota de origem. Atendo sábado de manhã."></div></div>
          <p class="suave" style="margin-top:12px">O anúncio fica no ar por ${estado.params.procura_validade_dias ?? 30} dias, no endereço da empresa (${esc(c.bairro ?? "")}, ${esc(c.cidade ?? "")}).</p>
        </div>
        <div class="acoes"><button type="button" class="btn btn-primario" id="publicar">Publicar anúncio de compra</button></div>`;
    }
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const obs = $("#obs", el)?.value ?? "";
      if (b.dataset.mat) { const id = Number(b.dataset.mat); R.mats.has(id) ? R.mats.delete(id) : R.mats.add(id); desenhar(); $("#obs", el).value = obs; return; }
      if (b.dataset.raioB) { R.raio = Number(b.dataset.raioB); desenhar(); $("#obs", el).value = obs; return; }
      if (b.dataset.minimo) { R.minimo = Number(b.dataset.minimo); desenhar(); $("#obs", el).value = obs; return; }
      if (b.id === "publicar") ocupado(b, async () => {
        if (!R.mats.size) throw new Error("Toque em pelo menos um material que você compra.");
        const { error } = await sb.rpc("slv_publicar_procura", { p_materiais: [...R.mats], p_raio_busca_km: R.raio, p_minimo_kg: R.minimo, p_paga_pix: $("#pix", el).checked, p_observacao: obs || null });
        if (error) throw error;
        avisar("Anúncio de compra publicado. Quem vende perto já vê você.", "ok");
        ir("minhas-procuras");
      });
    });
    el.addEventListener("change", (e) => { if (e.target.id === "pix") R.pix = e.target.checked; });
    desenhar();
  };

  TELAS["minhas-procuras"] = async (el) => {
    if (!estado.comprador) return ir("cad-comprador");
    await carregarCatalogo();
    const { data, error } = await sb.rpc("slv_minhas_procuras");
    if (error) throw error;
    const lista = data ?? [];
    const SIT = { publicado: ["No ar", "compra"], retirado: ["Retirado", ""], expirado: ["Expirou", "atencao"] };
    el.innerHTML = `<h1>Meus anúncios de compra</h1>
      <div class="acoes" style="margin-bottom:16px"><a class="btn btn-primario" href="#/anunciar-compra">Anunciar outro</a></div>
      ${lista.length ? `<div class="lista">${lista.map((p) => `
        <article class="cartao"><div class="cab"><h3>Compra ${esc(nomesMateriais(p.materiais))}</h3><span class="etiqueta ${SIT[p.status][1]}">${SIT[p.status][0]}</span></div>
          <p class="suave">${Number(p.raio_busca_km) > 0 ? `Busca até ${String(p.raio_busca_km).replace(".0", "")} km` : "Só no balcão"}${Number(p.minimo_kg) > 0 ? ` · mínimo ${String(p.minimo_kg).replace(".0", "")} kg` : ""}${p.paga_pix ? " · Pix na hora" : ""} · publicado ${ha(p.criado_em)}</p>
          ${p.observacao ? `<p>“${esc(p.observacao)}”</p>` : ""}
          <p><b class="num">${p.contatos}</b> pessoa${p.contatos === 1 ? "" : "s"} pediram o seu WhatsApp por este anúncio.</p>
          ${p.status === "publicado" ? `<div class="acoes"><button type="button" class="btn btn-perigo" data-retirar="${p.id}">Retirar anúncio</button></div>` : ""}
        </article>`).join("")}</div>`
        : `<div class="cartao vazio">Você ainda não anunciou o que compra. <a href="#/anunciar-compra">Anunciar agora</a>.</div>`}`;
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-retirar]"); if (!b) return;
      if (b.dataset.confirmar !== "1") { b.dataset.confirmar = "1"; b.textContent = "Toque de novo para retirar"; return; }
      ocupado(b, async () => { const { error: er } = await sb.rpc("slv_retirar_procura", { p_procura: Number(b.dataset.retirar) }); if (er) throw er; avisar("Anúncio retirado.", "ok"); window.Acomp.desfez("procura"); ir("minhas-procuras"); });
    });
  };

  const SIT_OFERTA = { enviada: ["Enviada, esperando resposta", ""], aceita: ["Aceita", "ok"], nao_aceita: ["Não aceita", ""], retirada: ["Retirada", ""], encerrado: ["Anúncio encerrado", "atencao"] };
  TELAS["minhas-ofertas"] = async (el) => {
    if (!estado.comprador) return ir("cad-comprador");
    await carregarCatalogo();
    const { data, error } = await sb.rpc("slv_minhas_ofertas");
    if (error) throw error;
    const lista = data ?? [];
    el.innerHTML = `<h1>Minhas ofertas</h1>
      ${lista.length ? `<div class="lista">${lista.map((o) => `
        <article class="cartao ${o.situacao === "aceita" ? "destaque" : ""}">
          <div class="cab"><h3>${esc(tituloItens(o.itens))}</h3><span class="etiqueta ${SIT_OFERTA[o.situacao][1]}">${SIT_OFERTA[o.situacao][0]}</span></div>
          <p class="suave">${esc([o.bairro, o.cidade].filter(Boolean).join(", "))} · ${ha(o.atualizado_em)}</p>
          <p>Sua oferta: <b class="valor">${reais(o.valor)}</b></p>
          ${o.situacao === "aceita" ? `<div class="zap">${esc(o.vendedor_nome ?? "Quem vende")} aceitou. WhatsApp: <b>${esc(o.vendedor_telefone ? fmtTel(o.vendedor_telefone) : "não informado")}</b>
            <span class="suave">Combine a retirada e pese na balança. Pague o valor combinado.</span></div>` : ""}
          ${o.situacao === "enviada" ? `<div class="acoes"><button type="button" class="btn btn-perigo" data-retirar="${o.id}">Retirar oferta</button></div>` : ""}
        </article>`).join("")}</div>`
        : `<div class="cartao vazio">Você ainda não mandou oferta. <a href="#/anuncios">Ver anúncios perto</a>.</div>`}`;
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-retirar]"); if (!b) return;
      ocupado(b, async () => { const { error: er } = await sb.rpc("slv_retirar_oferta", { p_oferta: Number(b.dataset.retirar) }); if (er) throw er; avisar("Oferta retirada.", "ok"); window.Acomp.desfez("oferta"); ir("minhas-ofertas"); });
    });
  };

  // ── sugestões e operador ─────────────────────────────────────────────────
  const STATUS_SUG = {
    nova: ["Nova", ""], em_analise: ["Em análise", "atencao"], aprovada: ["Aprovada", "ok"], em_execucao: ["Fazendo", "atencao"],
    concluida: ["Feita", "ok"], rejeitada: ["Não vamos fazer", "ruim"], depois: ["Mais para frente", ""],
  };
  const TIPO_SUG = { ideia: "💡 Ideia", problema: "⚠️ Problema", duvida: "❓ Dúvida" };

  TELAS.sugestoes = async (el) => {
    if (!estado.eu) {
      el.innerHTML = `<h1>Sugestões</h1><div class="cartao"><p>Termine seu cadastro para mandar sugestões. Enquanto isso, use o 💬 no canto.</p></div>`; return;
    }
    const { data } = await sb.from("slv_sugestoes").select("*").eq("autor_id", estado.sessao.user.id).order("criado_em", { ascending: false });
    el.innerHTML = `
      <h1>Sugestões</h1>
      <p class="suave">Ideia, problema ou dúvida. A gente lê tudo e responde aqui. Só você e a equipe veem o que você manda.</p>
      <div class="cartao" id="nova">${window.Acomp.formularioHTML("sg")}
        <div class="acoes"><button class="btn btn-primario" id="sg-enviar">Enviar</button></div></div>
      <h2>O que você já mandou</h2>
      <div class="lista">${(data ?? []).map((s) => `
        <div class="item-lista"><span class="etiqueta ${STATUS_SUG[s.status][1]}">${STATUS_SUG[s.status][0]}</span>
          <small class="suave"> ${TIPO_SUG[s.tipo]} · ${new Date(s.criado_em).toLocaleDateString("pt-BR")}</small>
          <p style="margin-top:8px">${esc(s.texto)}</p>
          ${s.resposta ? `<p><b>Resposta:</b> ${esc(s.resposta)}</p>${s.retorno ? `<small class="suave">Você disse: ${s.retorno === "ficou_bom" ? "ficou bom" : "ainda não ficou"}</small>` : ""}` : ""}
        </div>`).join("") || `<p class="suave">Nada ainda.</p>`}</div>`;
    const enviar = window.Acomp.ligarFormulario($("#nova", el), "sg", { via: "sugestoes", aoEnviar: () => { avisar("Anotado! 🙌", "ok"); ir("sugestoes"); } });
    $("#sg-enviar", el).addEventListener("click", (e) => ocupado(e.currentTarget, enviar));
  };

  TELAS.operador = async (el) => {
    if (!estado.operador) return ir(telaInicial());
    const conta = (t, f) => { let q = sb.from(t).select("*", { count: "exact", head: true }); if (f) q = f(q); return q; };
    const [vend, comp, pend, esp, anu, vend2, { data: exc }, { data: sugs }] = await Promise.all([
      conta("slv_vendedores"), conta("slv_compradores", (q) => q.eq("status", "aprovado")),
      conta("slv_compradores", (q) => q.eq("status", "pendente")), conta("slv_lista_espera"),
      conta("slv_anuncios", (q) => q.eq("status", "publicado")), conta("slv_anuncios", (q) => q.eq("status", "vendido")),
      sb.from("slv_excecoes").select("*").is("resolvida_em", null).order("criada_em"),
      sb.from("slv_sugestoes").select("*").order("criado_em", { ascending: false }).limit(50),
    ]);
    const meta = Number(estado.params.meta_vendedores_90d ?? 500);
    await carregarCatalogo(); await carregarReferencia();
    const { data: refEquipe } = await sb.from("slv_precos_referencia").select("*").order("material_id");
    el.innerHTML = `
      <h1>Torre de Controle - Sucata Livre</h1>
      <div class="numeros">
        <div class="numero"><b>${vend.count ?? 0}</b>vendedores <small>(meta ${meta})</small></div>
        <div class="numero"><b>${comp.count ?? 0}</b>compradores aprovados</div>
        <div class="numero"><b>${anu.count ?? 0}</b>anúncios no ar</div>
        <div class="numero"><b>${vend2.count ?? 0}</b>anúncios vendidos</div>
        <div class="numero"><b>${pend.count ?? 0}</b>compradores em análise</div>
        <div class="numero"><b>${esp.count ?? 0}</b>na lista de espera</div>
      </div>
      <h2>Fila de exceções ${exc?.length ? `<span class="etiqueta atencao">${exc.length}</span>` : ""}</h2>
      <div class="lista">${(exc ?? []).map((x) => `
        <div class="item-lista" data-exc="${x.id}" data-ref="${esc(x.ref_id)}" data-tab="${esc(x.ref_tabela)}">
          <b>${esc(x.tipo.replace(/_/g, " "))}</b> <small class="suave">${new Date(x.criada_em).toLocaleString("pt-BR")}</small>
          <p>${esc(x.detalhe?.razao_social ?? "")} ${x.detalhe?.cnpj ? `· CNPJ ${esc(fmtCNPJ(x.detalhe.cnpj))}` : ""} ${x.detalhe?.cidade ? `· ${esc(x.detalhe.cidade)}/${esc(x.detalhe.uf)}` : ""}<br>
          <small>${esc((x.detalhe?.motivos ?? []).join("; "))}</small></p>
          <div class="campos"><div><input type="text" class="motivo" placeholder="Motivo (a pessoa vê se for recusa)"></div></div>
          <div class="acoes">${x.ref_tabela === "slv_compradores"
            ? `<button class="btn btn-primario" data-acao="aprovar">Aprovar</button><button class="btn btn-perigo" data-acao="recusar">Recusar</button>`
            : `<button class="btn btn-secundario" data-acao="arquivar">Arquivar</button>`}</div></div>`).join("") || `<p class="suave">Fila vazia.</p>`}</div>
      <h2>Preço de referência: pesquisa da equipe</h2>
      <p class="suave">R$/kg pago no balcão. Vale até haver ${estado.params.ref_min_ofertas ?? 5} vendas aceitas do material em ${estado.params.ref_janela_dias ?? 30} dias; aí o sistema passa a usar a média real sozinho.</p>
      <div class="cartao" style="overflow-x:auto"><table class="ref ref-edita"><thead><tr><th></th><th>Material</th><th>Mínimo</th><th>Máximo</th><th>Fonte</th><th>Hoje aparece</th><th></th></tr></thead><tbody>
      ${(refEquipe ?? []).map((r) => { const at = estado.ref?.[r.material_id]; return `<tr data-ref-mat="${r.material_id}"><td>${selo(r.material_id)}</td><td>${esc(MAT()[r.material_id]?.nome ?? "")}<br><small class="suave">${esc(r.nota ?? "")}</small></td>
        <td><input type="text" class="r-min" inputmode="decimal" value="${reais2(r.minimo)}"></td><td><input type="text" class="r-max" inputmode="decimal" value="${reais2(r.maximo)}"></td>
        <td><select class="r-fonte"><option value="pesquisa" ${r.fonte === "pesquisa" ? "selected" : ""}>Pesquisa</option><option value="estimativa" ${r.fonte === "estimativa" ? "selected" : ""}>Estimativa</option></select></td>
        <td>${at?.fonte === "ofertas" ? `<span class="etiqueta ok">média de ${at.n_ofertas} vendas</span>` : `<span class="etiqueta">${at?.n_ofertas ?? 0} vendas</span>`}</td>
        <td><button class="btn btn-secundario" data-acao="ref">Salvar</button></td></tr>`; }).join("")}
      </tbody></table></div>
      <h2>Sugestões</h2>
      <div class="lista">${(sugs ?? []).map((s) => `
        <div class="item-lista" data-sug="${s.id}">
          <small class="suave">${TIPO_SUG[s.tipo]} · ${esc(s.autor_nome ?? "")} · tela ${esc(s.tela ?? "-")} · ${new Date(s.criado_em).toLocaleString("pt-BR")}${s.origem === "voz" ? " · voz" : ""}${s.anexos?.length ? ` · ${s.anexos.length} print` : ""}</small>
          <p>${esc(s.texto)}</p>
          ${s.retorno ? `<p><small>Retorno: ${s.retorno === "ficou_bom" ? "ficou bom" : "ainda não ficou"}</small></p>` : ""}
          <div class="campos"><div><select class="st">${Object.entries(STATUS_SUG).map(([k, [n]]) => `<option value="${k}" ${k === s.status ? "selected" : ""}>${n}</option>`).join("")}</select></div>
            <div><input type="text" class="resp" placeholder="Resposta para quem sugeriu" value="${esc(s.resposta ?? "")}"></div></div>
          <div class="acoes"><button class="btn btn-secundario" data-acao="responder">Salvar</button></div></div>`).join("") || `<p class="suave">Nenhuma sugestão.</p>`}</div>`;
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-acao]"); if (!b) return;
      const item = b.closest(".item-lista");
      ocupado(b, async () => {
        const acao = b.dataset.acao;
        if (acao === "ref") {
          const tr = b.closest("tr");
          const mn = lerReais($(".r-min", tr).value), mx = lerReais($(".r-max", tr).value);
          if (!mn || !mx || mx < mn) throw new Error("Confira a faixa: o mínimo e o máximo em R$/kg, com o máximo maior ou igual ao mínimo.");
          const { error } = await sb.rpc("slv_salvar_referencia", { p_material: Number(tr.dataset.refMat), p_minimo: mn, p_maximo: mx, p_fonte: $(".r-fonte", tr).value });
          if (error) throw error;
          await carregarReferencia(); avisar("Referência salva.", "ok"); return;
        }
        if (acao === "responder") {
          const { error } = await sb.from("slv_sugestoes").update({ status: $(".st", item).value, resposta: $(".resp", item).value.trim() || null }).eq("id", item.dataset.sug);
          if (error) throw error; avisar("Resposta salva.", "ok"); return;
        }
        const motivo = $(".motivo", item)?.value.trim() || null;
        if (acao === "recusar" && !motivo) throw new Error("Escreva o motivo da recusa.");
        const { error } = acao === "arquivar"
          ? await sb.rpc("slv_arquivar_excecao", { p_id: Number(item.dataset.exc), p_motivo: motivo })
          : await sb.rpc("slv_decidir_comprador", { p_comprador: item.dataset.ref, p_acao: acao, p_motivo: motivo });
        if (error) throw error;
        avisar("Feito.", "ok"); ir("operador");
      });
    });
  };

  // ── início ───────────────────────────────────────────────────────────────
  async function aoEntrar() {
    $("#btn-menu").hidden = false;
    await Promise.all([carregarCatalogo(), carregarPerfil()]);
    window.Acomp.mostrarBotao(true);
  }

  window.Acomp.iniciar(sb, () => ({
    logado: !!estado.sessao && !!estado.eu, uid: estado.sessao?.user?.id, operador: estado.operador, avisar,
  }));

  sb.auth.onAuthStateChange((ev, sessao) => { if (ev === "TOKEN_REFRESHED") estado.sessao = sessao; });

  (async () => {
    const { data } = await sb.auth.getSession();
    estado.sessao = data.session;
    $("#btn-menu").hidden = false;
    if (estado.sessao) { try { await aoEntrar(); } catch (e) { console.warn(e); } }
    else { montarMenu(); carregarCatalogo().catch(() => {}); }
    await rota();
  })();

  window.SLV = { estado, ir, consultarCep }; // para inspeção no console
})();
