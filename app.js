/* ---------------------------------------------------------------
   Console de questões — etapa 1.

   Nenhum nome de lei, capítulo, assunto ou questão aparece aqui.
   Tudo o que o usuário lê vem dos JSON em cartuchos/.
   --------------------------------------------------------------- */

(function () {
  'use strict';

  var CHAVE_LOG = 'leiseca:log';
  var CHAVE_TESTE = 'leiseca:teste-de-escrita';
  var GRAVAR_A_CADA = 5;
  var LIMITE_AVISO = 4 * 1024 * 1024;
  var SEP = '\u001f';

  // ---------------- elementos ----------------

  var el = {
    avisos: document.getElementById('avisos'),
    telaSelecao: document.getElementById('tela-selecao'),
    telaEstudo: document.getElementById('tela-estudo'),
    resumo: document.getElementById('resumo-manifest'),
    listaCartuchos: document.getElementById('lista-cartuchos'),
    tituloCartucho: document.getElementById('titulo-cartucho'),
    alternarArvore: document.getElementById('alternar-arvore'),
    navegacao: document.getElementById('navegacao'),
    arvore: document.getElementById('arvore'),
    principal: document.getElementById('principal')
  };

  // ---------------- estado (só memória) ----------------

  var manifest = null;
  var cache = Object.create(null);      // arquivo -> { titulo, questoes }
  var cartucho = null;
  var raiz = null;                      // árvore de hierarquia do cartucho aberto
  var fechados = new Set();             // nós recolhidos, por caminho
  var caminhoSelecionado = [];          // [] = todas
  var questoesFiltradas = [];
  var indice = 0;

  // sessão: qid -> { ordem, respondida, escolha, t0 }
  // nunca vai para o disco: ao recarregar, toda questão volta a ser respondível.
  var sessao = new Map();

  var pedidoDeCartucho = 0;             // o clique mais recente em um cartucho vence

  var log = [];                         // log inteiro lido na inicialização
  var pendentes = [];                   // entradas desta sessão ainda não gravadas
  var desdeGravacao = 0;
  var respondidasNaSessao = 0;
  var armazenamentoOk = false;

  // ---------------- utilidades ----------------

  function criar(tag, classe, texto) {
    var n = document.createElement(tag);
    if (classe) n.className = classe;
    if (texto !== undefined && texto !== null) n.textContent = texto;
    return n;
  }

  function botao(classe, texto) {
    var b = criar('button', classe, texto);
    b.type = 'button';
    return b;
  }

  function limpar(no) {
    while (no.firstChild) no.removeChild(no.firstChild);
  }

  function agora() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function chave(caminho) {
    return caminho.join(SEP);
  }

  function caminhoDe(q) {
    if (!Array.isArray(q.hierarquia)) return [];
    var caminho = [];
    q.hierarquia.forEach(function (nivel) {
      if (typeof nivel === 'number' && isFinite(nivel)) nivel = String(nivel);
      if (typeof nivel === 'string' && nivel.trim() !== '') caminho.push(nivel);
    });
    return caminho;
  }

  function ehPrefixo(prefixo, caminho) {
    if (prefixo.length > caminho.length) return false;
    for (var i = 0; i < prefixo.length; i++) {
      if (prefixo[i] !== caminho[i]) return false;
    }
    return true;
  }

  function plural(n, um, muitos) {
    return n + ' ' + (n === 1 ? um : muitos);
  }

  // ---------------- avisos na interface (sem alert) ----------------

  var avisosAtivos = new Set();

  function aviso(id, texto, tipo) {
    if (avisosAtivos.has(id)) return;
    avisosAtivos.add(id);

    var caixa = criar('div', tipo === 'erro' ? 'aviso aviso-erro' : 'aviso');
    caixa.appendChild(criar('p', 'aviso-texto', texto));

    var fechar = botao('aviso-fechar', '\u00d7');
    fechar.setAttribute('aria-label', 'Dispensar aviso');
    fechar.addEventListener('click', function () {
      avisosAtivos.delete(id);
      if (caixa.parentNode) caixa.parentNode.removeChild(caixa);
    });

    caixa.appendChild(fechar);
    el.avisos.appendChild(caixa);
  }

  // ---------------- armazenamento ----------------

  function testarArmazenamento() {
    try {
      window.localStorage.setItem(CHAVE_TESTE, '1');
      window.localStorage.removeItem(CHAVE_TESTE);
      return true;
    } catch (e) {
      return false;
    }
  }

  function lerLog() {
    try {
      var bruto = window.localStorage.getItem(CHAVE_LOG);
      if (!bruto) return;
      var dados = JSON.parse(bruto);
      if (Array.isArray(dados)) {
        log = dados;
        if (bruto.length > LIMITE_AVISO) avisoLimite();
      } else {
        aviso('log-formato', 'O histórico salvo neste navegador não está no formato esperado. As respostas desta sessão serão gravadas a partir de um histórico novo.');
      }
    } catch (e) {
      aviso('log-formato', 'O histórico salvo neste navegador não pôde ser lido. As respostas desta sessão serão gravadas a partir de um histórico novo.');
    }
  }

  function avisoLimite() {
    aviso('log-limite', 'O histórico de respostas está perto do limite de armazenamento do navegador (cerca de 5 MB). Em breve novos registros podem falhar.');
  }

  // Relê o disco e acrescenta só o que ainda não foi gravado.
  // Nunca sobrescreve o disco com a cópia da memória.
  function gravar() {
    if (!armazenamentoOk || pendentes.length === 0) return;

    var aGravar = pendentes;
    var disco = [];

    try {
      var bruto = window.localStorage.getItem(CHAVE_LOG);
      if (bruto) {
        try {
          var dados = JSON.parse(bruto);
          if (Array.isArray(dados)) disco = dados;
        } catch (e) {
          disco = [];
        }
      }

      var serial = JSON.stringify(disco.concat(aGravar));
      window.localStorage.setItem(CHAVE_LOG, serial);

      pendentes = [];
      desdeGravacao = 0;

      if (serial.length > LIMITE_AVISO) avisoLimite();
    } catch (e) {
      // mantém as pendentes para tentar de novo mais tarde, sem reserializar a cada clique
      desdeGravacao = 0;
      aviso('log-cheio', 'Não foi possível gravar as últimas respostas: o armazenamento do navegador está cheio ou bloqueado. O app continua funcionando, mas o histórico não está sendo salvo.', 'erro');
    }
  }

  function registrar(entrada) {
    log.push(entrada);
    respondidasNaSessao++;
    if (!armazenamentoOk) return;
    pendentes.push(entrada);
    desdeGravacao++;
    if (desdeGravacao >= GRAVAR_A_CADA) gravar();
  }

  // ---------------- telas ----------------

  function mudarTela(nome) {
    gravar();
    el.telaSelecao.classList.toggle('oculta', nome !== 'selecao');
    el.telaEstudo.classList.toggle('oculta', nome !== 'estudo');
    window.scrollTo(0, 0);
  }

  function irParaSelecao() {
    fecharNav();
    mudarTela('selecao');
  }

  // ---------------- manifest e seleção ----------------

  function carregarManifest() {
    limpar(el.listaCartuchos);
    el.listaCartuchos.appendChild(criar('li', 'vazio', 'Carregando\u2026'));

    fetch('cartuchos/manifest.json').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (dados) {
      if (!dados || !Array.isArray(dados.cartuchos)) {
        throw new Error('manifest sem a lista de cartuchos');
      }
      manifest = dados;
      renderSelecao();
    }).catch(function (erro) {
      limpar(el.listaCartuchos);
      var li = criar('li', 'vazio');
      li.appendChild(criar('p', null, 'Não foi possível carregar cartuchos/manifest.json.'));
      li.appendChild(criar('p', null, 'Este app precisa ser servido por HTTP. Abrir o index.html direto do sistema de arquivos (file://) não funciona, porque o navegador bloqueia a leitura dos JSON. Rode "python3 -m http.server" na pasta do projeto e acesse http://localhost:8000, ou publique no GitHub Pages.'));
      li.appendChild(criar('p', 'detalhe', 'Detalhe: ' + erro.message));
      el.listaCartuchos.appendChild(li);
    });
  }

  function renderSelecao() {
    var lista = manifest.cartuchos;
    var total = typeof manifest.total_questoes === 'number'
      ? manifest.total_questoes
      : lista.reduce(function (s, m) { return s + (Number(m.n_questoes) || 0); }, 0);

    el.resumo.textContent = plural(lista.length, 'cartucho', 'cartuchos') + ' \u00b7 ' + plural(total, 'questão', 'questões');

    limpar(el.listaCartuchos);

    if (lista.length === 0) {
      el.listaCartuchos.appendChild(criar('li', 'vazio', 'O manifest não lista nenhum cartucho.'));
      return;
    }

    lista.forEach(function (meta) {
      var li = criar('li', 'cartucho');
      var b = botao('cartucho-botao');
      b.appendChild(criar('span', 'cartucho-titulo', meta.titulo || meta.id || meta.arquivo || '\u2014'));

      var n = Number(meta.n_questoes);
      if (isFinite(n) && n > 0) {
        b.appendChild(criar('span', 'cartucho-meta', plural(n, 'questão', 'questões')));
      }

      b.addEventListener('click', function () { abrirCartucho(meta, b); });
      li.appendChild(b);
      el.listaCartuchos.appendChild(li);
    });
  }

  // Aproveita o que dá para aproveitar e diz o que ficou de fora.
  function prepararCartucho(dados, nome) {
    if (!dados || !Array.isArray(dados.questoes)) return null;

    var descartadas = 0;
    var semGabarito = 0;

    var questoes = dados.questoes.filter(function (q) {
      var util = q && typeof q.id === 'string' && Array.isArray(q.alternativas) && q.alternativas.length > 0;
      if (!util) { descartadas++; return false; }

      var corretas = q.alternativas.filter(function (a) { return a && a.correta; }).length;
      if (corretas !== 1) semGabarito++;
      return true;
    });

    if (!questoes.length) return null;

    var problemas = [];
    if (descartadas) {
      problemas.push(plural(descartadas, 'questão fora do formato esperado', 'questões fora do formato esperado') + ' (ignorada' + (descartadas === 1 ? '' : 's') + ')');
    }
    if (semGabarito) {
      problemas.push(plural(semGabarito, 'questão sem exatamente uma alternativa correta', 'questões sem exatamente uma alternativa correta'));
    }
    if (problemas.length) {
      aviso('cartucho-parcial:' + nome, '"' + nome + '": ' + problemas.join(' e ') + '. O resto do cartucho funciona normalmente.');
    }

    return { titulo: dados.titulo || nome, questoes: questoes };
  }

  // Se montar a tela falhar, o erro é da tela — não do arquivo.
  function abrirTela(c, nome, arquivo) {
    try {
      entrarEstudo(c);
    } catch (erro) {
      aviso('tela:' + arquivo, 'O cartucho "' + nome + '" carregou, mas houve um erro ao montar a tela: ' + erro.message + '.', 'erro');
    }
  }

  function abrirCartucho(meta, b) {
    var nome = meta.titulo || meta.id || meta.arquivo;
    var arquivo = meta.arquivo;

    if (!arquivo) {
      aviso('cartucho-sem-arquivo:' + (meta.id || nome), 'O manifest não indica o arquivo de "' + nome + '". Os outros cartuchos continuam disponíveis.', 'erro');
      return;
    }

    if (b.hasAttribute('aria-busy')) return;       // toque duplo no mesmo botão: uma busca só
    var pedido = ++pedidoDeCartucho;               // invalida buscas mais antigas ainda no ar

    if (cache[arquivo]) {
      abrirTela(cache[arquivo], nome, arquivo);
      return;
    }

    b.setAttribute('aria-busy', 'true');

    fetch('cartuchos/' + arquivo).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (dados) {
      var c = prepararCartucho(dados, nome);
      if (!c) throw new Error('nenhuma questão válida no arquivo');
      cache[arquivo] = c;
      return c;
    }).catch(function (erro) {
      aviso('cartucho:' + arquivo, 'Não foi possível abrir "' + nome + '" (' + arquivo + '): ' + erro.message + '. Os outros cartuchos continuam disponíveis.', 'erro');
      return null;
    }).then(function (c) {
      b.removeAttribute('aria-busy');
      if (!c) return;
      if (pedido !== pedidoDeCartucho) return;     // o usuário clicou em outro cartucho depois
      abrirTela(c, nome, arquivo);
    });
  }

  // ---------------- árvore de hierarquia ----------------

  function novoNo(nome, caminho) {
    return { nome: nome, caminho: caminho, filhos: new Map(), total: 0 };
  }

  // Cada questão soma 1 em todos os nós do seu caminho: a contagem de um nó
  // já inclui os descendentes. Profundidade livre, sem níveis fixos.
  function montarArvore(questoes) {
    var r = novoNo(null, []);
    questoes.forEach(function (q) {
      var caminho = caminhoDe(q);
      var no = r;
      no.total++;
      for (var i = 0; i < caminho.length; i++) {
        var nome = caminho[i];
        if (!no.filhos.has(nome)) {
          no.filhos.set(nome, novoNo(nome, caminho.slice(0, i + 1)));
        }
        no = no.filhos.get(nome);
        no.total++;
      }
    });
    return r;
  }

  function linhaNo(no, ehTodas, li) {
    var linha = criar('div', 'no-linha');
    var temFilhos = !ehTodas && no.filhos.size > 0;

    if (temFilhos) {
      var k = chave(no.caminho);
      var fechado = fechados.has(k);
      var alternar = botao('no-toggle', fechado ? '\u25b8' : '\u25be');
      alternar.setAttribute('aria-expanded', String(!fechado));
      alternar.setAttribute('aria-label', (fechado ? 'Expandir ' : 'Recolher ') + no.nome);
      // alterna no lugar, sem reconstruir a árvore: reconstruir destruiria o
      // botão focado (teclado voltaria ao topo) e perderia a rolagem da coluna.
      alternar.addEventListener('click', function () {
        var vaiFechar = !fechados.has(k);
        if (vaiFechar) fechados.add(k); else fechados.delete(k);
        li.classList.toggle('fechado', vaiFechar);
        alternar.textContent = vaiFechar ? '\u25b8' : '\u25be';
        alternar.setAttribute('aria-expanded', String(!vaiFechar));
        alternar.setAttribute('aria-label', (vaiFechar ? 'Expandir ' : 'Recolher ') + no.nome);
      });
      linha.appendChild(alternar);
    } else {
      linha.appendChild(criar('span', 'no-toggle vazio', '\u00b7'));
    }

    var rotulo = botao('no-rotulo');
    rotulo.appendChild(criar('span', 'no-nome', ehTodas ? 'Todas' : no.nome));
    rotulo.appendChild(criar('span', 'no-contagem', String(no.total)));

    if (chave(no.caminho) === chave(caminhoSelecionado)) {
      rotulo.classList.add('selecionado');
      rotulo.setAttribute('aria-current', 'true');
    }

    rotulo.addEventListener('click', function () {
      fecharNav();                                 // antes de filtrar: senão o foco cai num nó já escondido
      aplicarFiltro(no.caminho.slice());
    });

    linha.appendChild(rotulo);
    return linha;
  }

  function itemNo(no) {
    var li = criar('li', 'no');
    if (fechados.has(chave(no.caminho))) li.classList.add('fechado');
    li.appendChild(linhaNo(no, false, li));

    if (no.filhos.size > 0) {
      var sub = criar('ul', 'nivel');
      no.filhos.forEach(function (f) { sub.appendChild(itemNo(f)); });
      li.appendChild(sub);
    }
    return li;
  }

  function renderArvore() {
    limpar(el.arvore);

    var lista = criar('ul', 'nivel');
    var liTodas = criar('li', 'no');
    liTodas.appendChild(linhaNo(raiz, true, liTodas));
    lista.appendChild(liTodas);

    raiz.filhos.forEach(function (no) { lista.appendChild(itemNo(no)); });
    el.arvore.appendChild(lista);

    var atual = caminhoSelecionado.length
      ? caminhoSelecionado[caminhoSelecionado.length - 1]
      : 'Todas';
    el.alternarArvore.textContent = 'Navegação \u00b7 ' + atual;
  }

  function aplicarFiltro(caminho) {
    caminhoSelecionado = caminho;
    questoesFiltradas = cartucho.questoes.filter(function (q) {
      return ehPrefixo(caminho, caminhoDe(q));
    });
    indice = 0;
    renderArvore();
    renderQuestao();
    window.scrollTo(0, 0);

    // a árvore foi redesenhada: devolve o foco ao nó escolhido, ou à questão
    // quando a árvore está recolhida (celular) e não pode receber foco.
    var selecionado = el.arvore.querySelector('.no-rotulo.selecionado');
    if (selecionado) selecionado.focus();
    if (document.activeElement === document.body) focarQuestao();
  }

  // ---------------- painel de navegação no celular ----------------

  function abrirNav() {
    el.navegacao.classList.add('aberta');
    el.alternarArvore.setAttribute('aria-expanded', 'true');
  }

  function fecharNav() {
    el.navegacao.classList.remove('aberta');
    el.alternarArvore.setAttribute('aria-expanded', 'false');
  }

  function alternarNav() {
    if (el.navegacao.classList.contains('aberta')) fecharNav(); else abrirNav();
  }

  // ---------------- estudo ----------------

  function entrarEstudo(c) {
    cartucho = c;
    raiz = montarArvore(c.questoes);
    fechados.clear();
    caminhoSelecionado = [];
    questoesFiltradas = c.questoes.slice();
    indice = 0;

    limpar(el.tituloCartucho);
    el.tituloCartucho.appendChild(criar('span', 'seta', '\u2190'));
    el.tituloCartucho.appendChild(criar('span', 'titulo-texto', c.titulo));
    el.tituloCartucho.title = 'Voltar à seleção de cartuchos';

    fecharNav();
    mudarTela('estudo');
    renderArvore();
    renderQuestao();
  }

  function ordemEmbaralhada(n) {
    var ordem = [];
    for (var i = 0; i < n; i++) ordem.push(i);
    for (var j = n - 1; j > 0; j--) {              // Fisher-Yates
      var k = Math.floor(Math.random() * (j + 1));
      var tmp = ordem[j]; ordem[j] = ordem[k]; ordem[k] = tmp;
    }
    return ordem;
  }

  // Embaralha uma vez por sessão, na primeira exibição da questão.
  function estadoDa(q) {
    var e = sessao.get(q.id);
    if (!e) {
      e = {
        ordem: ordemEmbaralhada(q.alternativas.length),
        respondida: false,
        escolha: -1,
        t0: 0
      };
      sessao.set(q.id, e);
    }
    return e;
  }

  function responder(q, e, origem) {
    if (e.respondida) return;                      // trava: cliques posteriores não alteram nada

    e.respondida = true;
    e.escolha = origem;

    registrar({
      qid: q.id,
      ts: Date.now(),
      escolha: origem,                             // índice no array original do cartucho
      acertou: !!q.alternativas[origem].correta,
      tempo_ms: Math.max(0, Math.round(agora() - e.t0)),
      modo: 'estudo'
    });

    renderQuestao('escolha');
  }

  function focarQuestao() {
    var artigo = el.principal.querySelector('.questao');
    if (artigo) artigo.focus();
  }

  // foco: 'escolha' (alternativa clicada), 'questao' (topo da questão) ou nada
  function renderQuestao(foco) {
    limpar(el.principal);

    if (questoesFiltradas.length === 0) {
      el.principal.appendChild(criar('p', 'vazio', 'Nenhuma questão neste trecho.'));
      return;
    }

    if (indice < 0) indice = 0;
    if (indice >= questoesFiltradas.length) indice = questoesFiltradas.length - 1;

    var q = questoesFiltradas[indice];
    var e = estadoDa(q);
    if (!e.respondida) e.t0 = agora();

    var artigo = criar('article', 'questao');
    artigo.tabIndex = -1;

    // cabeçalho
    var cab = criar('div', 'questao-cabecalho');
    if (q.dispositivo) cab.appendChild(criar('span', 'dispositivo', q.dispositivo));
    if (q.dificuldade) cab.appendChild(criar('span', 'etiqueta', q.dificuldade));
    cab.appendChild(criar('span', 'posicao', (indice + 1) + ' de ' + questoesFiltradas.length));
    artigo.appendChild(cab);

    artigo.appendChild(criar('p', 'enunciado', q.enunciado || ''));

    // alternativas
    var ul = criar('ul', e.respondida ? 'alternativas respondida' : 'alternativas');
    var botaoEscolhido = null;
    var exibidas = 0;

    e.ordem.forEach(function (origem) {
      var alt = q.alternativas[origem];
      if (!alt) return;

      var li = criar('li', 'item-alternativa');
      var b = botao('alternativa');
      b.appendChild(criar('span', 'letra', String.fromCharCode(65 + exibidas)));
      exibidas++;

      var texto = criar('span', 'texto', alt.texto || '');

      if (e.respondida) {
        var ehCorreta = !!alt.correta;
        var ehEscolhida = origem === e.escolha;

        if (ehCorreta) li.classList.add('correta');
        if (ehEscolhida && !ehCorreta) li.classList.add('escolhida-errada');

        if (ehEscolhida || ehCorreta) {
          var marca = ehEscolhida
            ? (ehCorreta ? 'Sua resposta \u00b7 correta' : 'Sua resposta \u00b7 incorreta')
            : 'Resposta correta';
          texto.appendChild(criar('span', 'marca-resposta', marca));
        }
        b.setAttribute('aria-disabled', 'true');
      }

      b.appendChild(texto);
      b.addEventListener('click', function () { responder(q, e, origem); });

      li.appendChild(b);
      if (origem === e.escolha) botaoEscolhido = b;

      // comentários só existem no DOM depois da resposta
      if (e.respondida && alt.comentario) {
        li.appendChild(criar('p', 'comentario', alt.comentario));
      }

      ul.appendChild(li);
    });

    artigo.appendChild(ul);

    // fundamento
    if (e.respondida && q.fundamento) {
      var bloco = criar('aside', 'fundamento');
      bloco.appendChild(criar('span', 'fundamento-rotulo', 'Fundamento'));
      bloco.appendChild(criar('p', 'fundamento-texto', q.fundamento));
      artigo.appendChild(bloco);
    }

    // passos
    var passos = criar('div', 'passos');

    var anterior = botao('passo', '\u2190 Anterior');
    anterior.disabled = indice === 0;
    anterior.addEventListener('click', function () {
      indice--;
      renderQuestao('questao');
      window.scrollTo(0, 0);
    });

    var proxima = botao('passo passo-principal', 'Próxima \u2192');
    proxima.addEventListener('click', function () {
      if (indice >= questoesFiltradas.length - 1) {
        renderFimDeConjunto();
      } else {
        indice++;
        renderQuestao('questao');
      }
      window.scrollTo(0, 0);
    });

    passos.appendChild(anterior);
    passos.appendChild(proxima);
    artigo.appendChild(passos);

    el.principal.appendChild(artigo);

    if (foco === 'escolha' && botaoEscolhido) botaoEscolhido.focus();
    else if (foco === 'questao') artigo.focus();
  }

  function renderFimDeConjunto() {
    gravar();
    limpar(el.principal);

    var fim = criar('section', 'fim');
    fim.appendChild(criar('h2', null, 'Fim do conjunto'));
    fim.appendChild(criar('p', null, 'Você respondeu ' + plural(respondidasNaSessao, 'questão', 'questões') + ' nesta sessão.'));

    var acoes = criar('div', 'fim-acoes');

    var paraArvore = botao('passo passo-principal', 'Escolher outro trecho');
    paraArvore.addEventListener('click', function () {
      abrirNav();
      var alvo = el.arvore.querySelector('.no-rotulo');
      if (alvo) alvo.focus();
    });

    var paraSelecao = botao('passo', 'Trocar de cartucho');
    paraSelecao.addEventListener('click', irParaSelecao);

    acoes.appendChild(paraArvore);
    acoes.appendChild(paraSelecao);
    fim.appendChild(acoes);

    el.principal.appendChild(fim);
  }

  // ---------------- início ----------------

  function iniciar() {
    armazenamentoOk = testarArmazenamento();

    if (armazenamentoOk) {
      lerLog();
    } else {
      aviso('sem-armazenamento', 'Este navegador não está permitindo gravar dados locais. O app funciona normalmente, mas as respostas não estão sendo registradas.');
    }

    el.tituloCartucho.addEventListener('click', irParaSelecao);
    el.alternarArvore.addEventListener('click', alternarNav);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') gravar();
    });
    window.addEventListener('pagehide', gravar);

    carregarManifest();
  }

  iniciar();
}());
