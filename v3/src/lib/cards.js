/* ui2 cards are {rank 0..12 (2..A), suit 0..3 (c, d, h, s)}; odds.js and the
 * classic add-on speak "As"/"Td" strings. */

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";

export const cardStr = (c) => (c && c.rank >= 0 && c.suit >= 0 ? RANKS[c.rank] + SUITS[c.suit] : null);
