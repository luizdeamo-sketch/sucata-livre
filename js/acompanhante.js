// Sucata Livre · acompanhante: registro de uso, balão 💬 (com voz e print), gatilhos automáticos e aviso de versão nova.
// Padrão "balao-e-sugestoes" do Luiz. O que a pessoa digita nos campos nunca é gravado.
(function () {
  const C = window.SLV_CONFIG;
  let sb = null, ctx = () => ({});
  let fila = [], ultimos = [];
  let telaAtual = null, historicoTelas = [];
  let ultimaOferta = 0, modalAberto = false;
  const UM_QUARTO = 15 * 60 * 1000;

  // ── registro de uso ──────────────────────────────────────────────────────
  const mascarar = (s) => String(s ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\d[\d.\-/() ]{3,}\d/g, "[número]")
    .slice(0, 300);

  function registrar(tipo, dados = {}) {
    const ev = { tipo, tela: telaAtual, alvo: dados.alvo ? mascarar(dados.alvo) : null, dados, criado_em: new Date().toISOString() };
    ultimos.push(ev); if (ultimos.length > 20) ultimos.shift();
    if (ctx().logado) fila.push(ev);
  }

  async function enviar() {
    if (!sb || !fila.length || !ctx().logado) return;
    const lote = fila.splice(0, fila.length);
    const { error } = await sb.from("slv_eventos").insert(lote);
    if (error) console.warn("eventos", error.message);
  }

  function descrever(el) {
    const alvo = el.closest("button, a, [role=button], .chip, .material, input, select, textarea, label");
    if (!alvo) return null;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(alvo.tagName)) return `${alvo.tagName.toLowerCase()}:${alvo.name || alvo.id || ""}`;
    return (alvo.getAttribute("aria-label") || alvo.textContent || "").trim().slice(0, 60);
  }

  // ── gatilhos automáticos ─────────────────────────────────────────────────
  let cliques = [];
  function aoClicar(e) {
    const alvo = descrever(e.target);
    if (!alvo) return;
    registrar("clique", { alvo });
    const agora = Date.now();
    cliques = cliques.filter((c) => agora - c.t < 1000 && c.alvo === alvo);
    cliques.push({ t: agora, alvo });
    if (cliques.length >= 3) { cliques = []; registrar("raiva", { alvo }); oferecer("travou", "Parece que algo não respondeu. Quer contar o que aconteceu?"); }
  }

  function tela(nome) {
    if (telaAtual === nome) return;
    const agora = Date.now();
    historicoTelas.push({ nome, t: agora });
    if (historicoTelas.length > 3) historicoTelas.shift();
    const [a, b, c] = historicoTelas;
    telaAtual = nome;
    registrar("tela", { nome });
    // voltou: A → B → A em menos de 30 s
    if (c && a.nome === c.nome && a.nome !== b.nome && c.t - a.t < 30000) {
      oferecer("voltou", "Não achou o que procurava? Conta pra gente.");
    }
  }

  function recusa(msg) { registrar("aviso", { msg: mascarar(msg) }); oferecer("recusa", "Deu algum problema aí? Se quiser, explica o que tentou fazer."); }
  function erro(msg) { registrar("erro", { msg: mascarar(msg) }); }
  function desfez(oque) { registrar("aviso", { desfez: oque }); oferecer("desfez", "Mudou de ideia? Se algo confundiu, conta pra gente."); }

  function podeOferecer() {
    const c = ctx();
    if (!c.logado || c.operador || modalAberto) return false;
    return Date.now() - ultimaOferta > UM_QUARTO;
  }

  function oferecer(motivo, pergunta) {
    if (!podeOferecer()) return;
    ultimaOferta = Date.now();
    document.querySelector(".balao-oferta")?.remove();
    const box = document.createElement("div");
    box.className = "balao-oferta";
    box.innerHTML = `<p>${pergunta}</p><div class="acoes">
      <button type="button" class="btn btn-primario" data-a="sim">Contar</button>
      <button type="button" class="btn btn-secundario" data-a="nao">Agora não</button></div>`;
    document.body.appendChild(box);
    registrar("balao", { acao: "ofereceu", motivo });
    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      box.remove();
      registrar("balao", { acao: a === "sim" ? "aceitou" : "dispensou", motivo });
      if (a === "sim") abrirBalao("balao", motivo, pergunta);
    });
    setTimeout(() => box.remove(), 20000);
  }

  // ── caixa "Conta pra gente" (balão e tela Sugestões usam a mesma) ─────────
  function formularioHTML(prefixo) {
    return `
      <div class="campos">
        <div><label for="${prefixo}-tipo">Sobre o quê?</label>
          <select id="${prefixo}-tipo">
            <option value="ideia">💡 Ideia de melhoria</option>
            <option value="problema">⚠️ Algo não funciona</option>
            <option value="duvida">❓ Dúvida</option>
          </select></div>
      </div>
      <div style="margin-top:14px"><label for="${prefixo}-texto">Escreva ou fale</label>
        <textarea id="${prefixo}-texto" placeholder="Conte do seu jeito…"></textarea></div>
      <div class="acoes" style="margin-top:10px">
        <button type="button" class="btn btn-secundario" id="${prefixo}-falar">🎤 Falar</button>
        <label class="btn btn-secundario" style="margin:0">📸 Anexar print<input type="file" id="${prefixo}-arquivo" accept="image/*" multiple hidden></label>
      </div>
      <small class="dica">Você também pode colar um print aqui (Ctrl+V).</small>
      <div class="anexos" id="${prefixo}-anexos"></div>`;
  }

  // liga voz, anexos e envio num formulário já desenhado
  function ligarFormulario(raiz, prefixo, { via, motivo, pergunta, aoEnviar }) {
    const estado = { anexos: [], audio: null, origem: "texto", rec: null, gravador: null, pedacos: [] };
    const $ = (s) => raiz.querySelector(s);
    const texto = $(`#${prefixo}-texto`), btnFalar = $(`#${prefixo}-falar`), lista = $(`#${prefixo}-anexos`);

    const addAnexo = (file) => {
      if (!file || !file.type.startsWith("image/") || estado.anexos.length >= 4) return;
      estado.anexos.push(file);
      const img = document.createElement("img"); img.src = URL.createObjectURL(file); img.alt = "print anexado";
      lista.appendChild(img);
    };
    $(`#${prefixo}-arquivo`).addEventListener("change", (e) => [...e.target.files].forEach(addAnexo));
    raiz.addEventListener("paste", (e) => [...(e.clipboardData?.files ?? [])].forEach(addAnexo));
    raiz.addEventListener("dragover", (e) => e.preventDefault());
    raiz.addEventListener("drop", (e) => { e.preventDefault(); [...(e.dataTransfer?.files ?? [])].forEach(addAnexo); });

    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    btnFalar.addEventListener("click", async () => {
      if (estado.rec) { parar(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        estado.pedacos = [];
        estado.gravador = new MediaRecorder(stream);
        estado.gravador.ondataavailable = (e) => e.data.size && estado.pedacos.push(e.data);
        estado.gravador.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          estado.audio = new Blob(estado.pedacos, { type: estado.gravador.mimeType || "audio/webm" });
        };
        estado.gravador.start();
      } catch { /* sem microfone: segue só com o ditado, se houver */ }
      if (Rec) {
        estado.rec = new Rec(); estado.rec.lang = "pt-BR"; estado.rec.continuous = true; estado.rec.interimResults = false;
        estado.rec.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) texto.value += (texto.value ? " " : "") + e.results[i][0].transcript;
        };
        estado.rec.onend = () => estado.rec && parar();
        estado.rec.start();
      } else estado.rec = { stop() {} };
      estado.origem = "voz";
      btnFalar.textContent = "⏹ Parar"; btnFalar.classList.add("gravando");
    });
    function parar() {
      const r = estado.rec; estado.rec = null; try { r?.stop(); } catch {}
      if (estado.gravador?.state === "recording") estado.gravador.stop();
      btnFalar.textContent = "🎤 Falar"; btnFalar.classList.remove("gravando");
    }

    return async function enviarSugestao() {
      parar();
      const t = texto.value.trim();
      if (!t && !estado.audio) throw new Error("Escreva ou fale alguma coisa antes de enviar.");
      const uid = ctx().uid;
      const base = `${uid}/${Date.now()}`;
      const anexos = [];
      for (const [i, f] of estado.anexos.entries()) {
        const caminho = `${base}-print${i + 1}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
        const { error } = await sb.storage.from("slv-sugestoes").upload(caminho, f, { contentType: f.type });
        if (!error) anexos.push(caminho);
      }
      let audio_path = null;
      if (estado.audio && estado.audio.size) {
        await new Promise((r) => setTimeout(r, 200));
        const caminho = `${base}-audio.webm`;
        const { error } = await sb.storage.from("slv-sugestoes").upload(caminho, estado.audio, { contentType: estado.audio.type });
        if (!error) audio_path = caminho;
      }
      const linha = {
        tipo: $(`#${prefixo}-tipo`).value, texto: t || "(mensagem só em áudio)", tela: telaAtual,
        origem: estado.origem, via, anexos, audio_path,
        contexto: { via, motivo: motivo ?? null, pergunta: pergunta ?? null, rota: location.hash, largura: innerWidth, ultimos },
      };
      const { error } = await sb.from("slv_sugestoes").insert(linha);
      if (error) throw new Error("Não conseguimos enviar agora. Tente de novo.");
      registrar("balao", { acao: "enviou", via, motivo: motivo ?? null });
      aoEnviar?.();
    };
  }

  function abrirBalao(via = "balao", motivo = null, pergunta = null) {
    if (modalAberto) return;
    modalAberto = true;
    registrar("balao", { acao: "abriu", via, motivo });
    const fundo = document.createElement("div");
    fundo.className = "modal-fundo";
    fundo.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="bl-titulo">
      <h2 id="bl-titulo" style="margin-top:0">Conta pra gente 💬</h2>
      <p class="suave">${pergunta ? pergunta : "Ideia, problema ou dúvida: a gente lê tudo e responde aqui no app."}</p>
      ${formularioHTML("bl")}
      <div class="acoes">
        <button type="button" class="btn btn-primario" id="bl-enviar">Enviar</button>
        <button type="button" class="btn btn-secundario" id="bl-fechar">Fechar</button>
      </div></div>`;
    document.body.appendChild(fundo);
    const fechar = () => { fundo.remove(); modalAberto = false; registrar("balao", { acao: "fechou", via }); };
    const enviarSug = ligarFormulario(fundo, "bl", { via, motivo, pergunta, aoEnviar: () => { fundo.remove(); modalAberto = false; ctx().avisar?.("Anotado! 🙌", "ok"); } });
    fundo.querySelector("#bl-fechar").addEventListener("click", fechar);
    fundo.addEventListener("click", (e) => { if (e.target === fundo) fechar(); });
    const btn = fundo.querySelector("#bl-enviar");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try { await enviarSug(); } catch (e) { ctx().avisar?.(e.message, "erro"); btn.disabled = false; }
    });
    fundo.querySelector("#bl-texto").focus();
  }

  function mostrarBotao(visivel) {
    let b = document.querySelector(".balao-btn");
    if (!b) {
      b = document.createElement("button");
      b.type = "button"; b.className = "balao-btn"; b.textContent = "💬"; b.setAttribute("aria-label", "Conta pra gente");
      b.addEventListener("click", () => abrirBalao("balao", null, null));
      document.body.appendChild(b);
    }
    b.hidden = !visivel;
  }

  // ── versão nova (nunca recarrega sozinho) ────────────────────────────────
  async function verificarVersao() {
    try {
      const r = await fetch(`versao.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const { versao } = await r.json();
      if (versao && versao !== C.versao) {
        const f = document.getElementById("faixa-versao");
        f.hidden = false;
        f.dataset.versao = versao;
      }
    } catch { /* sem rede: tenta de novo depois */ }
  }

  function mostrarNovidades() {
    let vista = null;
    try { vista = localStorage.getItem("slv-novidades-vista"); } catch {}
    const pendente = (() => { try { return localStorage.getItem("slv-atualizou"); } catch { return null; } })();
    if (!pendente || vista === C.versao) return;
    try { localStorage.removeItem("slv-atualizou"); localStorage.setItem("slv-novidades-vista", C.versao); } catch {}
    const n = (window.NOVIDADES || []).find((x) => x.versao === C.versao);
    if (!n) return;
    const fundo = document.createElement("div");
    fundo.className = "modal-fundo";
    fundo.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2 style="margin-top:0">O que mudou (${n.data})</h2>
      <ul>${n.itens.map((i) => `<li>${i}</li>`).join("")}</ul>
      <div class="acoes"><button type="button" class="btn btn-primario">Entendi</button></div></div>`;
    fundo.querySelector("button").addEventListener("click", () => fundo.remove());
    document.body.appendChild(fundo);
  }

  function iniciar(cliente, contexto) {
    sb = cliente; ctx = contexto;
    document.addEventListener("click", aoClicar, true);
    setInterval(enviar, 15000);
    addEventListener("pagehide", () => { registrar("saida", {}); enviar(); });
    document.getElementById("btn-atualizar").addEventListener("click", () => {
      try { localStorage.setItem("slv-atualizou", "1"); } catch {}
      location.reload();
    });
    verificarVersao();
    setInterval(verificarVersao, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && verificarVersao());
    mostrarNovidades();
  }

  window.Acomp = { iniciar, tela, recusa, erro, desfez, abrirBalao, mostrarBotao, formularioHTML, ligarFormulario, registrar, enviar };
})();
