/**
 * Labels are written in sentence case (grill_wildeye_visual_update_2026-10-20, Q10): the first letter
 * capitalised and the rest left as the source wrote it, so "Aedes albopictus", "West Nile virus" and
 * "SE Pacific" keep their case. Never upper-case a whole label: it hides a binomial's genus/species
 * case and maps µ to M in unit strings.
 * @param {string} s
 * @returns {string}
 */
export const sentenceCase = (s) => {
  const t = String(s ?? '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};
