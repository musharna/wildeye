# Adjacent-radar check (docs/analysis/bird-pairs.md): per neighbour pair, night-to-night agreement and level
# agreement of the new nightly migration totals against the old plain-mean product, with the fixed bars.
# Run from the repo root: Rscript docs/analysis/bird_pairs_figure.R
source("docs/analysis/wildeye_theme.R")

d <- read.csv("docs/analysis/bird_pairs.csv", encoding = "UTF-8")
v <- jsonlite::fromJSON("docs/analysis/bird_pairs.json")$verdict
long <- rbind(
  data.frame(pair = d$pair, arm = d$arm, metric = "Night-to-night agreement (Spearman, bar ≥ 0.8)", value = d$spearman),
  data.frame(pair = d$pair, arm = d$arm, metric = "Level gap (median ratio folded ≥ 1, bar ≤ 1.5)", value = d$folded_ratio)
)
ord <- d[d$arm == "new", ]
long$pair <- factor(long$pair, levels = ord$pair[order(ord$spearman)])
long$arm <- factor(ifelse(long$arm == "new", "new: nightly migration traffic (bioRad mt)", "old: plain mean density"),
                   levels = c("new: nightly migration traffic (bioRad mt)", "old: plain mean density"))
metrics <- c("Night-to-night agreement (Spearman, bar ≥ 0.8)", "Level gap (median ratio folded ≥ 1, bar ≤ 1.5)")
long$metric <- factor(long$metric, levels = metrics)
bars <- data.frame(metric = factor(metrics, levels = metrics), bar = c(0.8, 1.5))

c <- wildeye_colours
p <- ggplot(long, aes(value, pair, colour = arm)) +
  geom_vline(data = bars, aes(xintercept = bar), colour = c$text_dim, linetype = "dashed", linewidth = 0.4) +
  geom_line(aes(group = pair), colour = c$grid, linewidth = 1.2) +
  geom_point(size = 2.6) +
  facet_wrap(~metric, scales = "free_x") +
  scale_colour_manual(values = setNames(c(c$accent, c$warm), levels(long$arm)), name = NULL) +
  labs(x = NULL, y = NULL,
       title = sprintf("Do neighbouring radars agree? Pre-registered verdict: %s", ifelse(v$pass, "PASS", "FAIL")),
       subtitle = sprintf("11 NEXRAD pairs 166-250 km apart · 20 nights 27 Sep-16 Oct 2026 · medians: Spearman %.2f (old %.2f), ratio %.2f (old %.2f)",
                          v$median_spearman$new, v$median_spearman$old, v$median_folded_ratio$new, v$median_folded_ratio$old)) +
  theme_wildeye()

ggsave("docs/analysis/bird_pairs.png", p, width = 11, height = 5.5, dpi = 150, bg = c$bg)
