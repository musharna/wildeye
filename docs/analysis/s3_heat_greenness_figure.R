# S3 pilot figure (docs/analysis/s3-heat-greenness-prereg.md): mean daytime LST per 0.02 EVI bin,
# by land-cover group, one panel per region; the strip carries the pre-registered matched gap.
# Run from the repo root: Rscript docs/analysis/s3_heat_greenness_figure.R
source("docs/analysis/wildeye_theme.R")

bins <- read.csv("docs/analysis/s3_heat_greenness_bins.csv", encoding = "UTF-8")
reg <- read.csv("docs/analysis/s3_heat_greenness_regions.csv", encoding = "UTF-8")

reg$label <- ifelse(
  reg$testable == "True",
  sprintf("%s   city − cropland %+.2f °C [%+.2f, %+.2f]%s", reg$region, reg$gap, reg$ci_lo, reg$ci_hi,
          ifelse(reg$passes == "True", "  ✓", "  ✗")),
  sprintf("%s   not testable (no cropland)", reg$region)
)
reg <- reg[order(-ifelse(is.na(reg$gap), -Inf, reg$gap)), ]
bins$panel <- factor(reg$label[match(bins$region, reg$region)], levels = reg$label)
bins$evi <- bins$evi_bin_lo + 0.01
bins$group <- factor(bins$group, levels = c("city", "cropland", "forest"))

c <- wildeye_colours
p <- ggplot(bins, aes(evi, mean_lst_c, colour = group)) +
  geom_line(linewidth = 0.4, alpha = 0.6) +
  geom_point(aes(size = n), alpha = 0.85, stroke = 0) +
  facet_wrap(~panel, ncol = 2, scales = "free_y") +
  scale_colour_manual(values = c(city = c$warm, cropland = c$accent, forest = c$text_dim), name = NULL) +
  scale_size_area(max_size = 4, breaks = c(10, 100, 1000), name = "points per bin") +
  labs(
    x = "EVI (0.02 bins)", y = "Mean daytime land surface temperature (°C)",
    title = sprintf("Are cities hotter than cropland at the same greenness? Pre-registered verdict: %s", reg$verdict[1]),
    subtitle = sprintf("MODIS IGBP %s · EVI 16-day %s · LST day 8-day %s · 1° boxes · PASS needs ≥75%% of testable regions",
                       reg$lc_date[1], reg$evi_date[1], reg$lst_date[1])
  ) +
  guides(size = guide_legend(override.aes = list(colour = c$text))) +
  theme_wildeye()

ggsave("docs/analysis/s3_heat_greenness.png", p, width = 11, height = 11, dpi = 150, bg = c$bg)
