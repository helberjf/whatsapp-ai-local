// Trava de saída das respostas da IA. Modelos pequenos às vezes ignoram "use só o contexto": inventam horário,
// endereço, preço ou prazo, ou copiam as instruções quando o cliente pede. Aqui a resposta só passa se cada dado
// desse tipo aparecer no que foi enviado à IA (catálogo, trechos, conversa, regras). Senão, vai para o atendente.
// Não detecta afirmações inventadas sem números (por exemplo, "o visto é obrigatório").
const normalize=text=>String(text ?? '').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
const compact=text=>text.replace(/[\s.]/g,'');

const FACTS=[
  ['preço',/r\$\s?\d[\d.]*(?:,\d{1,2})?/g],
  ['parcelamento',/\b\d{1,2}\s?x\b/g],
  ['prazo',/\b\d+(?:\s?(?:a|-|ou)\s?\d+)?\s?(?:dias?|horas?|minutos?|semanas?|mes(?:es)?|anos?)\b/g],
  ['horário',/\b\d{1,2}\s?h(?:\d{2})?\b|\b\d{1,2}:\d{2}\b/g],
  ['percentual',/\b\d+(?:,\d+)?\s?%/g],
  ['telefone',/\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g],
  ['documento',/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g],
  ['endereço',/\b(?:rua|avenida|av\.|travessa|alameda|rodovia)\s+[a-z .]{3,40},?\s*(?:n[o.]?\s*)?\d+|\b\d{5}-\d{3}\b/g]
];
const MARKERS=['<catalogo','</catalogo','<contexto','</contexto','regras de atendimento da empresa','voce e o assistente de atendimento da empresa'];

// Devolve null quando a resposta pode sair; senão {kind, items} com o motivo.
function inspect(answer,{context=[],rules=[]}={}) {
  const text=normalize(answer);if(!text.trim()) return null;
  const marker=MARKERS.find(item=>text.includes(item));
  if(marker) return {kind:'vazamento',items:[marker]};
  // Duas ou mais frases das regras internas copiadas ao pé da letra indicam que a IA despejou as instruções.
  const copied=rules.flatMap(rule=>normalize(rule.text).split(/(?<=[.!?:])\s+/)).filter(sentence=>sentence.length>=40 && text.includes(sentence));
  if(copied.length>=2) return {kind:'vazamento',items:copied.slice(0,2)};
  const known=compact(normalize(context.join('\n'))),missing=[];
  // O número precisa aparecer inteiro: "1,00" não vale por estar dentro de "21,00".
  const has=value=>new RegExp('(?<![\\d,])'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?!\\d)').test(known);
  for(const [label,pattern] of FACTS) for(const match of text.match(pattern) || []) {
    // Preço: vale o número, com ou sem "R$" e centavos zerados ("preco: 289,90" na base sustenta "R$ 289,90").
    const item=compact(match).replace(/,$/,''),value=label==='preço'?item.replace(/^r\$/,''):item;
    if(!has(value) && !(label==='preço' && /^\d{3,},00$/.test(value) && has(value.slice(0,-3)))) missing.push(`${label}: ${match.trim()}`);
  }
  return missing.length?{kind:'sem-base',items:[...new Set(missing)].slice(0,5)}:null;
}
const describe=result=>result.kind==='vazamento'?'a resposta copiava instruções internas':'a resposta trazia dados que não estão na base nem na conversa ('+result.items.join('; ')+')';
module.exports={inspect,describe};
