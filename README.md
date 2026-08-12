# 🎯 Quiz de Requisitos

Quiz multiplayer **em tempo real** sobre Requisitos Funcionais, Não Funcionais e Regras de Negócio.
Estilo Kahoot: um **telão** mostra a pergunta e o placar ao vivo, a galera responde pelo **celular** e joga em **equipes**.

- 41 perguntas (classificação RF/RNF/RN + múltipla escolha) com explicação em cada resposta
- Equipes criadas pelos próprios jogadores no lobby
- Placar ao vivo, bônus por velocidade e por sequência de acertos
- **Zero dependências** — Node puro, tempo real com SSE

## Rodar

```bash
node server.js
# telão:     http://localhost:3000/host
# jogadores: http://localhost:3000/
```

Na mesma rede Wi-Fi, a galera acessa pelo IP da máquina (o servidor imprime no boot).

## Como funciona a partida

1. Você abre `/host` e clica em **Criar sala** → aparece um código de 4 letras no telão.
2. Cada pessoa abre a raiz do site no celular, digita o código e o nome.
3. No lobby elas **criam ou entram em equipes**.
4. Você clica em **Iniciar partida**. O servidor controla o cronômetro: todos veem a mesma pergunta ao mesmo tempo.
5. A cada rodada o telão mostra a resposta correta, a explicação, a distribuição das respostas e o ranking.

**Pontuação:** 500 pontos base + até 500 por velocidade + até 300 de bônus por sequência.
A nota da equipe é a **média** dos integrantes — assim equipe pequena não é penalizada.

## Deploy no Coolify

1. Suba a pasta num repositório Git e crie uma **Application** apontando pra ele.
2. **Build Pack: Dockerfile** (o `Dockerfile` já está aqui). Nixpacks também funciona.
3. **Port exposed: `3000`**.
4. Ative o domínio/HTTPS normalmente — o SSE já vai com `X-Accel-Buffering: no` e `Cache-Control: no-transform`, então passa limpo pelo proxy.

⚠️ **Mantenha 1 réplica.** O estado das salas fica em memória; com 2+ instâncias os jogadores cairiam em processos diferentes. Para escalar horizontalmente seria preciso mover o estado pra Redis.

### Variáveis de ambiente (todas opcionais)

| Variável | Padrão | O que faz |
|---|---|---|
| `PORT` | `3000` | Porta HTTP (o Coolify injeta) |
| `QUESTION_MS` | `25000` | Tempo de cada pergunta |
| `REVEAL_MS` | `9000` | Tempo mostrando a resposta |
| `ROUND_SIZE` | `12` | Perguntas por partida (o host também escolhe na tela) |

## Arquivos

```
server.js          API + SSE + máquina de estados da partida
questions.js       banco de perguntas (é só editar pra adicionar as suas)
public/index.html  app do jogador (celular)
public/host.html   telão do apresentador
public/style.css   design compartilhado
```

Para adicionar perguntas, edite `questions.js`:

```js
c('Frase para classificar…', 0, 'Explicação.')   // 0=RF, 1=RNF, 2=RN
m('Pergunta?', ['a', 'b', 'c', 'd'], 1, 'Explicação.')  // índice da correta
```
