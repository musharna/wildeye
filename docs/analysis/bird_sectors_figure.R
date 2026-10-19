# Land-sector probe (docs/analysis/bird-sectors.md): per coastal radar, how much the old density product rises
# when vol2bird reads only the land-facing directions, against the rise sea dilution predicts and the fixed bar.
# Run from the repo root: Rscript docs/analysis/bird_sectors_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/bird_sectors.json")
sea <- jsonlite::fromJSON("docs/analysis/radar_sectors.json")
r <- doc$verdict$radars
ids <- names(r)
d <- data.frame(radar = ids, sea = sapply(ids, function(s) sea[[s]]$sea_share),
                factor = sapply(r, `[[`, "factor"), predicted = sapply(r, `[[`, "predicted"),
                needed = sapply(r, `[[`, "needed"))
d$label <- factor(sprintf("%s (sea %.0f%%)", d$radar, 100 * d$sea), levels = sprintf("%s (sea %.0f%%)", d$radar, 100 * d$sea)[order(d$sea)])
pts <- rbind(data.frame(label = d$label, what = "measured land / full ring", x = d$factor),
             data.frame(label = d$label, what = "predicted if sea dilutes the ring", x = d$predicted))

c <- wildeye_colours
p <- ggplot() +
  geom_vline(xintercept = c(1, 1.1), colour = c$text_dim, linetype = c("solid", "dashed"), linewidth = 0.4) +
  geom_segment(data = d, aes(x = factor, xend = predicted, y = label, yend = label), colour = c$grid, linewidth = 1.2) +
  geom_point(data = d, aes(needed, label), shape = 124, size = 6, colour = c$text_dim) +
  geom_point(data = pts, aes(x, label, colour = what), size = 2.8) +
  scale_colour_manual(values = c("measured land / full ring" = c$accent, "predicted if sea dilutes the ring" = c$warm), name = NULL) +
  labs(x = "Density factor, land sector over full ring (median of 20 nights)", y = NULL,
       title = sprintf("Is the coastal shortfall sea in the ring? Pre-registered verdict: %s", doc$verdict$verdict),
       subtitle = "Tick: rise needed (halfway to predicted) · dashed 1.1: below counts against · 27 Sep-16 Oct 2026") +
  theme_wildeye()

ggsave("docs/analysis/bird_sectors.png", p, width = 10, height = 4, dpi = 150, bg = c$bg)
