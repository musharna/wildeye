# E0c waterbird detection control (docs/analysis/e0c-waterbird-detection.md), one figure from e0c_waterbird.json:
#   e0c_waterbird.png  mean rank score s with its county-bootstrap CI for the gate (waterbird Trauma) and the two
#                      Bacteria halves, at real dates and 26 weeks later (placebo). The dashed line is E0b's Bacteria
#                      finding: the gate rules a detection effect of that size out only if its CI ends left of it.
# Run from the repo root: Rscript docs/analysis/e0c_waterbird_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/e0c_waterbird.json", simplifyVector = FALSE)
labels <- c(waterbird_trauma = "Gate: waterbird Trauma (95%)",
            waterbird_bacteria = "Waterbird Bacteria (97.5%)",
            other_bird_bacteria = "Other-bird Bacteria (97.5%)")
arm <- function(block, label) do.call(rbind, lapply(names(labels), function(k) {
  r <- block$classes[[k]]
  data.frame(cls = labels[[k]], arm = label, mean = r$mean_s, lo = r$ci[[1]], hi = r$ci[[2]], n = r$cases)
}))
rows <- rbind(arm(doc$real, "real dates"), arm(doc$placebo, "+26 weeks (placebo)"))
rows$cls <- factor(rows$cls, levels = rev(unname(labels)))
c <- wildeye_colours
g <- doc$real$classes$waterbird_trauma
f <- doc$verdict$finding_tested_against
p <- ggplot(rows, aes(mean, cls, colour = arm)) +
  geom_vline(xintercept = 0, colour = c$text_dim, linewidth = 0.4) +
  geom_vline(xintercept = f, colour = c$warm, linewidth = 0.5, linetype = "dashed") +
  geom_errorbar(aes(xmin = lo, xmax = hi), width = 0, orientation = "y", linewidth = 0.8,
                position = position_dodge(width = 0.5)) +
  geom_point(size = 2.2, position = position_dodge(width = 0.5)) +
  annotate("text", x = f, y = 3.45, label = sprintf("E0b finding +%.3f", f), colour = c$warm,
           hjust = -0.05, size = 3.2) +
  scale_colour_manual(values = c("real dates" = c$accent, "+26 weeks (placebo)" = c$text_dim), name = NULL) +
  labs(x = "Mean rank score s of the die-off week's drought among the same week 4 years either side (0 = no drier)",
       y = NULL,
       title = sprintf("Waterbird Trauma: s = %+.3f, CI up to %+.3f, so inconclusive",
                       g$mean_s, g$ci[[2]]),
       subtitle = sprintf(paste0("%d waterbird Trauma die-offs, US counties 2001-2025. A detection effect the size of\n",
                                 "E0b's finding is ruled out only if the gate's CI ends left of the dashed line.\n",
                                 "Bacteria's lean sits in waterbird events (descriptive)."), g$cases)) +
  theme_wildeye()
ggsave("docs/analysis/e0c_waterbird.png", p, width = 11, height = 5, dpi = 150, bg = c$bg)
