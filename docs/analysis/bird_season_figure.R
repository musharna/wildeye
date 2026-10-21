# Year-on-year check (docs/analysis/bird-season.md): per adjacent radar pair, each radar's fall 2026 / fall 2025
# migration total over the nights both falls have; the pair's disagreement max(rA/rB, rB/rA) is the gap between the
# two points on the log axis. The popup's "last fall" line ships if the median disagreement is <= 1.5 over >= 6 pairs.
# Run from the repo root: Rscript docs/analysis/bird_season_figure.R
source("docs/analysis/wildeye_theme.R")

v <- jsonlite::fromJSON("docs/analysis/bird_season.json", simplifyVector = FALSE)
pairs <- do.call(rbind, lapply(v$pairs, function(p) data.frame(
  a = p$pair[[1]], b = p$pair[[2]], ra = p$ratio_a, rb = p$ratio_b, dis = p$disagreement)))
nights <- function(s) v$radars[[s]]$nights
pairs$label <- sprintf("%s %.2f · %s %.2f   → %.2f×   (%d / %d nights)", pairs$a, pairs$ra, pairs$b, pairs$rb,
                       pairs$dis, sapply(pairs$a, nights), sapply(pairs$b, nights))
pairs$label <- factor(pairs$label, levels = pairs$label[order(pairs$dis)])
pts <- rbind(data.frame(label = pairs$label, radar = pairs$a, r = pairs$ra),
             data.frame(label = pairs$label, radar = pairs$b, r = pairs$rb))

c <- wildeye_colours
p <- ggplot(pts, aes(r, label)) +
  geom_vline(xintercept = 1, colour = c$text_dim, linewidth = 0.4) +
  geom_line(aes(group = label), colour = c$accent, linewidth = 1.2, alpha = 0.5) +
  geom_point(colour = c$accent, size = 2.6) +
  scale_x_log10(breaks = c(0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5), limits = c(0.6, 1.6)) +
  labs(x = "fall 2026 / fall 2025, same nights (log scale; 1 = same as last fall)", y = NULL,
       title = sprintf("Neighbouring radars agree on the change from last fall: %s",
                       ifelse(v$ships, "yes, the comparison ships", "no, it stays off")),
       subtitle = sprintf("%d adjacent NEXRAD pairs · Aug 1-Oct 19 · median disagreement %.2f× (limit %.1f× over ≥ %d pairs, fixed 10-19)",
                          length(v$pairs), v$median_disagreement, v$max_disagreement, v$min_pairs)) +
  theme_wildeye() +
  theme(plot.title.position = "plot")

ggsave("docs/analysis/bird_season.png", p, width = 10, height = 5.5, dpi = 150, bg = c$bg)
