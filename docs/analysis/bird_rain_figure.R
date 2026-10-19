# Rain flag (docs/analysis/bird-rain.md): balanced accuracy of "bio_gate_share < t means rain" against airport
# gauges, per threshold, on the ten nights that chose t and on the ten held out, with the ship bar.
# Run from the repo root: Rscript docs/analysis/bird_rain_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/bird_rain.json")
t <- as.numeric(names(doc$curve))
d <- rbind(data.frame(t = t, arm = "first 10 nights (chose t)", ba = sapply(doc$curve, `[[`, "fit")),
           data.frame(t = t, arm = "last 10 nights (held out)", ba = sapply(doc$curve, `[[`, "held_out")))

c <- wildeye_colours
p <- ggplot(d, aes(t, ba, colour = arm)) +
  geom_hline(yintercept = 0.75, colour = c$text_dim, linetype = "dashed", linewidth = 0.4) +
  geom_vline(xintercept = doc$threshold, colour = c$grid, linewidth = 1.2) +
  geom_line(linewidth = 0.9) +
  geom_point(size = 1.8) +
  scale_colour_manual(values = c("first 10 nights (chose t)" = c$warm, "last 10 nights (held out)" = c$accent), name = NULL) +
  scale_x_continuous(breaks = seq(0.1, 0.9, 0.1)) +
  labs(x = "Flag a scan as rain when bio_gate_share is below t", y = "Balanced accuracy vs gauges",
       title = sprintf("Rain flag at t = %.2f: held-out balanced accuracy %.2f (bar 0.75, dashed)",
                       doc$threshold, doc$held_out_balanced_accuracy),
       subtitle = sprintf("14 NEXRAD radars · nearest ASOS gauge ≤ 40 km · held out: %d rain, %d dry scans · 27 Sep-16 Oct 2026",
                          doc$held_out_counts$rain, doc$held_out_counts$dry)) +
  theme_wildeye()

ggsave("docs/analysis/bird_rain.png", p, width = 10, height = 4.5, dpi = 150, bg = c$bg)
