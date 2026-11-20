# A0 fast-flier gate (docs/analysis/a0-fast-fliers.md), one figure from a0_fast_fliers.json:
#   a0_fast_fliers.png  per radar and fall, the share of the season's bird density in fast bins (airspeed >= 15 m/s),
#                       against M1's 2 % bar. The deciding gate: no radar reaches it in either fall.
# Run from the repo root: Rscript docs/analysis/a0_fast_fliers_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/a0_fast_fliers.json", simplifyVector = FALSE)
sites <- jsonlite::fromJSON("pipeline/sites.json")
rows <- do.call(rbind, lapply(c("2025", "2026"), function(y) {
  s <- doc$gates[[paste0("M1_", y)]]$fast_share
  data.frame(site = names(s), fall = y, share = 100 * vapply(s, function(v) if (is.null(v)) NA_real_ else v, 0))
}))
stopifnot(nrow(rows) == 40, !anyNA(rows$share))
rows$site <- factor(rows$site, levels = sites$id[order(sites$lat)])
c <- wildeye_colours
p <- ggplot(rows, aes(share, site, colour = fall)) +
  geom_vline(xintercept = 2, colour = c$text_dim, linetype = "dashed", linewidth = 0.4) +
  annotate("text", x = 2, y = Inf, label = "M1 bar: 2 %", colour = c$text_dim, hjust = 1.05, vjust = 1.5, size = 3.2) +
  geom_point(size = 2.2, position = position_dodge(width = 0.5)) +
  scale_colour_manual(values = c("2025" = c$accent, "2026" = c$warm), name = "Fall") +
  scale_x_continuous(limits = c(0, 2.2), labels = function(x) paste0(x, " %"), expand = c(0, 0.02)) +
  labs(title = "Almost no radar density moves at waterfowl speed",
       subtitle = "Per radar, share of Aug 1 - Nov 15 density in bins at >= 15 m/s airspeed",
       x = "Fast share of season density", y = NULL) +
  theme_wildeye()
ggsave("docs/analysis/a0_fast_fliers.png", p, width = 7.5, height = 6, dpi = 150, bg = c$bg)
