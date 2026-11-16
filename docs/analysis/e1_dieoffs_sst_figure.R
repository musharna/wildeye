# E1 coastal die-offs x sea warmth (docs/analysis/e1-dieoffs-sea-warmth.md), one figure from e1_dieoffs_sst.json:
#   e1_dieoffs_sst.png  mean rank score s with its county-bootstrap CI for each class at its real dates and 26 weeks
#                       later (placebo), Nut/Met/Dev without the murre die-off, and the two exact-expectation plants.
#                       0 = die-off weeks no warmer than the same week in the neighbouring years.
# Run from the repo root: Rscript docs/analysis/e1_dieoffs_sst_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/e1_dieoffs_sst.json", simplifyVector = FALSE)
arm <- function(block, label) do.call(rbind, lapply(names(block$classes), function(k) {
  r <- block$classes[[k]]
  data.frame(cls = k, arm = label, mean = r$mean_s, lo = r$ci[[1]], hi = r$ci[[2]], n = r$cases)
}))
nm <- arm(doc$nut_met_dev_without_murres, "real dates")
nm$cls <- "Nut/Met/Dev without murres"
rows <- rbind(arm(doc$real, "real dates"), arm(doc$placebo, "+26 weeks (placebo)"), nm,
              arm(doc$expected_beta_0, "plant"), arm(doc$expected_beta_1, "plant"))
rows$cls[rows$cls == "expected_beta_0"] <- "plant: no effect"
rows$cls[rows$cls == "expected_beta_1"] <- "plant: beta = 1 per C"
classes <- sort(unique(rows$cls[!grepl("^plant|without", rows$cls)]), decreasing = TRUE)
rows$cls <- factor(rows$cls, levels = c(classes, "Nut/Met/Dev without murres", "plant: no effect",
                                        "plant: beta = 1 per C"))
found <- unlist(doc$verdict$findings)
c <- wildeye_colours
cols <- c("real dates" = c$accent, "+26 weeks (placebo)" = c$text_dim, "plant" = c$warm)
m <- doc$murre_check
p <- ggplot(rows, aes(mean, cls, colour = arm)) +
  geom_vline(xintercept = 0, colour = c$text_dim, linewidth = 0.4) +
  geom_errorbar(aes(xmin = lo, xmax = hi), width = 0, orientation = "y", linewidth = 0.8,
                position = position_dodge(width = 0.6)) +
  geom_point(size = 2.2, position = position_dodge(width = 0.6)) +
  scale_colour_manual(values = cols, name = NULL) +
  labs(x = "Mean rank score s of the die-off week's sea-surface temperature among the same week 4 years either side",
       y = NULL,
       title = sprintf("Coastal die-offs and warm water: %s (%s)",
                       if (length(found)) paste("finding:", paste(found, collapse = ", ")) else "no finding",
                       doc$verdict$status),
       subtitle = sprintf(paste0("%s confirmed WHISPers die-offs in %s coastal US counties, 2001-2025; CIs at %.2f%%.\n",
                                 "Known positive: the 2015-16 murre die-off weeks ran %.1f SD above 1997-2012 (%d cases)."),
                          format(doc$cases_coastal, big.mark = ","), doc$coastal_counties, 100 * doc$real$level,
                          m$mean_z, m$scored)) +
  theme_wildeye()
ggsave("docs/analysis/e1_dieoffs_sst.png", p, width = 11, height = 6.4, dpi = 150, bg = c$bg)
