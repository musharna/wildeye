# E0 die-offs x drought (docs/analysis/e0-dieoffs-drought.md), two figures:
#   e0_dieoffs.png    mean case z with its county-bootstrap CI for every arm: each class at its real dates and at the
#                     +26-week placebo, and the two planted arms. The no-effect plant (beta = 0) should sit on 0.
#   e0_null_bias.png  the case z of the no-effect plant: the median is below 0, the mean is pulled above it by a 2 %
#                     right tail (analysis/e0_null_bias.py).
# Run from the repo root: Rscript docs/analysis/e0_dieoffs_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/e0_dieoffs.json", simplifyVector = FALSE)
nb <- jsonlite::fromJSON("docs/analysis/e0_null_bias.json")
arm <- function(block, label) do.call(rbind, lapply(names(block$classes), function(k) {
  r <- block$classes[[k]]
  data.frame(cls = k, arm = label, mean = r$mean_z, lo = r$ci[[1]], hi = r$ci[[2]], n = r$cases)
}))
rows <- rbind(arm(doc$real, "real dates"), arm(doc$placebo, "+26 weeks (placebo)"),
              arm(doc$planted_beta_0, "planted, no effect"), arm(doc$planted_beta_1, "planted, beta = 1"))
rows$cls[rows$cls == "planted_beta_0"] <- "planted: no effect"
rows$cls[rows$cls == "planted_beta_1"] <- "planted: beta = 1"
order <- c(sort(unique(rows$cls[!grepl("^planted", rows$cls)]), decreasing = TRUE), "planted: beta = 1", "planted: no effect")
rows$cls <- factor(rows$cls, levels = order)
c <- wildeye_colours
cols <- c("real dates" = c$accent, "+26 weeks (placebo)" = c$text_dim, "planted, no effect" = c$warm, "planted, beta = 1" = "#ffffff")
p0 <- doc$planted_beta_0$classes$planted_beta_0
p <- ggplot(rows, aes(mean, cls, colour = arm)) +
  geom_vline(xintercept = 0, colour = c$text_dim, linewidth = 0.4) +
  geom_errorbar(aes(xmin = lo, xmax = hi), width = 0, orientation = "y", linewidth = 0.8, position = position_dodge(width = 0.6)) +
  geom_point(size = 2.2, position = position_dodge(width = 0.6)) +
  scale_colour_manual(values = cols, name = NULL) +
  scale_x_continuous(breaks = seq(-1, 5, 1)) +
  coord_cartesian(xlim = c(-0.5, 4.6)) +
  labs(x = "Mean drought z of the cases (bars: county-bootstrap CI, Bonferroni over 8 classes)", y = NULL,
       title = sprintf("E0 is VOID: a plant with no effect reads drought\n(mean z %.2f, CI %.2f to %.2f)",
                       p0$mean_z, p0$ci[[1]], p0$ci[[2]]),
       subtitle = sprintf(paste0("%s confirmed WHISPers die-offs, US counties 2001-2025; drought (USDM DSCI) of the case week\n",
                                 "against the same week 4 years either side. Every arm sits right of 0, Trauma and the\n",
                                 "placebo too: the statistic puts them there, not drought."),
                          format(doc$cases_confirmed, big.mark = ","))) +
  theme_wildeye()
ggsave("docs/analysis/e0_dieoffs.png", p, width = 10, height = 6.2, dpi = 150, bg = c$bg)

n0 <- nb$null_all_years
z <- data.frame(z = n0$z)
marks <- data.frame(v = c(n0$median_z, n0$mean_z), what = c("median", "mean"))
q <- ggplot(z, aes(asinh(z))) +
  geom_histogram(binwidth = 0.1, fill = c$warm, colour = NA, alpha = 0.85) +
  geom_vline(data = marks, aes(xintercept = asinh(v), linetype = what), colour = c$text, linewidth = 0.5) +
  scale_linetype_manual(values = c(mean = "solid", median = "dashed"), name = NULL) +
  scale_x_continuous(breaks = asinh(c(-3, -1, 0, 1, 3, 10, 100, 1000)), labels = c(-3, -1, 0, 1, 3, 10, 100, 1000)) +
  labs(x = "Case z under the no-effect plant (asinh scale)", y = "Cases",
       title = sprintf("Under no effect, the median z is %.2f but the mean is %.2f", n0$median_z, n0$mean_z),
       subtitle = sprintf(paste0("%.0f%% of cases have z > 5 (largest %s): weeks of drought among calm years, whose ",
                                 "spread is near 0.\nz cannot fall below about -3. Clipped to +-3 the mean is %.2f; ",
                                 "a rank statistic averages %.3f (0.5 = no effect)."),
                          100 * n0$share_z_over_5, format(round(n0$max_z), big.mark = ","), n0$mean_z_clipped_3, n0$rank_mean)) +
  theme_wildeye()
ggsave("docs/analysis/e0_null_bias.png", q, width = 10, height = 5.2, dpi = 150, bg = c$bg)
