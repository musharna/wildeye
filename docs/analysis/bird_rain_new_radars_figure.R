# Rain markers at six radars the gauge checks had not seen (docs/analysis/bird-rain.md): balanced accuracy at the
# existing 0.55, per scan and per night, per radar and pooled, with the keep bar.
# Run from the repo root: Rscript docs/analysis/bird_rain_new_radars_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/bird_rain_new_radars.json")
row <- function(site, v) data.frame(
  site = site, unit = c("scans", "nights"),
  ba = c(if (is.null(v$scan_balanced_accuracy)) NA else v$scan_balanced_accuracy,
         if (is.null(v$night_balanced_accuracy)) NA else v$night_balanced_accuracy),
  n = c(sprintf("%d/%d", v$scan_counts$rain, v$scan_counts$dry), sprintf("%d/%d", v$night_counts$rain, v$night_counts$dry)))
d <- do.call(rbind, c(lapply(names(doc$per_site), function(s) row(s, doc$per_site[[s]])), list(row("all 6", doc))))
d$site <- factor(d$site, levels = c(names(doc$per_site), "all 6"))

c <- wildeye_colours
p <- ggplot(d, aes(site, ba, colour = unit)) +
  geom_hline(yintercept = 0.75, colour = c$text_dim, linetype = "dashed", linewidth = 0.4) +
  geom_point(size = 3, position = position_dodge(width = 0.5)) +
  geom_text(aes(label = n), position = position_dodge(width = 0.5), vjust = -1.1, size = 2.8, show.legend = FALSE) +
  scale_colour_manual(values = c(scans = c$accent, nights = c$warm), name = "rain/dry labelled") +
  scale_y_continuous(limits = c(0.5, 1.05), breaks = seq(0.5, 1, 0.1)) +
  labs(x = NULL, y = "Balanced accuracy vs gauges",
       title = sprintf("At t = %.2f, unchanged: scans %.2f, nights %.2f pooled (bar 0.75, dashed)",
                       doc$threshold, doc$scan_balanced_accuracy, doc$night_balanced_accuracy),
       subtitle = "Pooled verdict only: per-radar night points rest on 1-7 rain nights · 10-minute scans · 27 Sep-16 Oct 2026") +
  theme_wildeye()

ggsave("docs/analysis/bird_rain_new_radars.png", p, width = 10, height = 4.5, dpi = 150, bg = c$bg)
