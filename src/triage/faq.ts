/**
 * Ready answers for simple questions. Written by people, chosen by the model:
 * the model picks a topic, the text comes from here, so an automatic answer
 * can never promise something the store does not do.
 */
export const FAQ_TOPICS = ["prazo_entrega", "formas_pagamento", "politica_troca", "rastreio", "nenhum"] as const;
export type FaqTopic = (typeof FAQ_TOPICS)[number];

export const FAQ: Record<Exclude<FaqTopic, "nenhum">, string> = {
  prazo_entrega: "O prazo de entrega aparece no carrinho, antes de pagar, e vai de 3 a 10 dias úteis conforme o CEP. Ele começa a contar depois que o pagamento é aprovado.",
  formas_pagamento: "Aceitamos Pix, boleto e cartão de crédito em até 6 vezes sem juros. Pix e cartão são aprovados na hora; o boleto, em até 2 dias úteis.",
  politica_troca: "Você pode trocar ou devolver em até 30 dias depois de receber, com o produto sem uso e na embalagem original. A primeira troca tem frete grátis.",
  rastreio: "O código de rastreio chega por e-mail quando o pedido sai do nosso estoque, e também aparece em Minha conta → Pedidos.",
};
