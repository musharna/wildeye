# E0b die-offs x drought, rank score (docs/analysis/e0b-dieoffs-drought-rank.md), one figure from e0b_dieoffs.json:
#   e0b_dieoffs.png  mean rank score s with its county-bootstrap CI for each class at its real dates and 26 weeks
#                    later (placebo), and the two exact-expectation plants. 0 = die-off weeks no drier than the same
#                    week in the neighbouring years; the beta = 1 plant shows what a clear drought effect reads.
# Run from the repo root: Rscript docs/analysis/e0b_dieoffs_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/e0b_dieoffs.json", simplifyVector = FALSE)
arm <- function(block, label) do.call(rbind, lapply(names(block$classes), function(k) {
  r <- block$classes[[k]]
  data.frame(cls = k, arm = label, mean = r$mean_s, lo = r$ci[[1]], hi = r$ci[[2]], n = r$cases)
}))
rows <- rbind(arm(doc$real, "real dates"), arm(doc$placebo, "+26 weeks (placebo)"),
              arm(doc$expected_beta_0, "plant"), arm(doc$expected_beta_1, "plant"))
rows$cls[rows$cls == "expected_beta_0"] <- "plant: no effect"
rows$cls[rows$cls == "expected_beta_1"] <- "plant: beta = 1"
classes <- sort(unique(rows$cls[!grepl("^plant", rows$cls)]), decreasing = TRUE)
rows$cls <- factor(rows$cls, levels = c(classes, "plant: no effect", "plant: beta = 1"))
found <- unlist(doc$verdict$findings)
c <- wildeye_colours
cols <- c("real dates" = c$accent, "+26 weeks (placebo)" = c$text_dim, "plant" = c$warm)
b <- doc$verdict$per_class$Bacteria$real
p <- ggplot(rows, aes(mean, cls, colour = arm)) +
  geom_vline(xintercept = 0, colour = c$text_dim, linewidth = 0.4) +
  geom_errorbar(aes(xmin = lo, xmax = hi), width = 0, orientation = "y", linewidth = 0.8,
                position = position_dodge(width = 0.6)) +
  geom_point(size = 2.2, position = position_dodge(width = 0.6)) +
  scale_colour_manual(values = cols, name = NULL) +
  labs(x = "Mean rank score s of the die-off week's drought among the same week 4 years either side (0 = no drier)",
       y = NULL,
       title = sprintf("Bacterial die-offs start in slightly drier weeks: s = +%.3f (CI %.3f to %.3f)",
                       b$mean_s, b$ci[[1]], b$ci[[2]]),
       subtitle = sprintf(paste0("%s confirmed WHISPers die-offs, US counties 2001-2025; CIs at %.2f%% (8 classes).\n",
                                 "Finding: %s. Virus and Other read above 0 too, but so do their placebos; Toxin (botulism)\n",
                                 "and Trauma (the control) do not. A clear drought effect (the beta = 1 plant) reads %.2f."),
                          format(doc$cases_confirmed, big.mark = ","), 100 * doc$real$level,
                          paste(found, collapse = ", "), doc$expected_beta_1$classes$expected_beta_1$mean_s)) +
  theme_wildeye()
ggsave("docs/analysis/e0b_dieoffs.png", p, width = 11, height = 6.2, dpi = 150, bg = c$bg)
