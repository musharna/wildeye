# Night-total sampling error (docs/analysis/bird-sampling.md): per radar-night, the total from one scan per
# 10 minutes against the total from every scan, with the ± q band fixed on the first ten nights.
# Run from the repo root: Rscript docs/analysis/bird_sampling_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/bird_sampling.json")
d <- doc$nights[!is.na(doc$nights$r), ]
d$night <- as.Date(d$night)
d$arm <- ifelse(d$night >= as.Date(doc$split_night), "last 10 nights (held out)", "first 10 nights (set q)")

c <- wildeye_colours
p <- ggplot(d, aes(night, 100 * r, colour = arm)) +
  annotate("rect", xmin = min(d$night) - 1, xmax = max(d$night) + 1, ymin = -100 * doc$q, ymax = 100 * doc$q, fill = c$grid) +
  geom_hline(yintercept = 0, colour = c$text_dim, linewidth = 0.3) +
  geom_point(size = 2, alpha = 0.85, position = position_jitter(width = 0.15, height = 0, seed = 1)) +
  scale_colour_manual(values = c("first 10 nights (set q)" = c$warm, "last 10 nights (held out)" = c$accent), name = NULL) +
  scale_y_continuous(labels = function(x) paste0(x, "%")) +
  labs(x = NULL, y = "10-minute total vs every-scan total",
       title = sprintf("± %.1f%% (shaded) held on %.0f%% of %d held-out nights (bar 85%%)",
                       100 * doc$q, 100 * doc$held_out_inside, doc$held_out_nights),
       subtitle = sprintf("6 NEXRAD radars (KBUF KGRR KILN KLOT KFFC KOHX) · one point per radar-night · %d nights set q · 27 Sep-16 Oct 2026",
                          doc$fit_nights)) +
  theme_wildeye()

ggsave("docs/analysis/bird_sampling.png", p, width = 10, height = 4.5, dpi = 150, bg = c$bg)
