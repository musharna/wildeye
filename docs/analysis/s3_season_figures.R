# S3 season rerun figures (docs/analysis/s3_season_prereg.md), in the wildeye house style.
#   s3_season_verdict.png: mean LST per 0.02 EVI bin, city vs cropland, each region at its peak-greenness date;
#                          the strip carries the pre-registered peak-date gap.
#   s3_season_curve.png:   per region, the city - cropland gap through 2024 (95% CI ribbon) beside the
#                          median cropland and city EVI; peak date (solid) and September arm (dashed) marked.
# Run from the repo root: Rscript docs/analysis/s3_season_figures.R [in_dir] [out_dir]
source("docs/analysis/wildeye_theme.R")
args <- commandArgs(trailingOnly = TRUE)
in_dir <- if (length(args) >= 1) args[1] else "docs/analysis"
out_dir <- if (length(args) >= 2) args[2] else "docs/analysis"
c <- wildeye_colours

reg <- read.csv(file.path(in_dir, "s3_season_regions.csv"), encoding = "UTF-8")
curve <- read.csv(file.path(in_dir, "s3_season_curve.csv"), encoding = "UTF-8")
bins <- read.csv(file.path(in_dir, "s3_season_bins.csv"), encoding = "UTF-8")
curve$date <- as.Date(curve$date)
# a gap from fewer than 30 matched pixels per group is not a result: blank it (the line breaks there)
untestable <- !(curve$testable %in% c("True", TRUE))
curve[untestable, c("gap", "ci_lo", "ci_hi")] <- NA
# kept as columns so they stay aligned when reg is re-sorted below
reg$is_testable <- reg$peak_testable %in% c("True", TRUE)
reg$is_pass <- reg$peak_passes %in% c("True", TRUE)
reg$label <- ifelse(
  reg$is_testable,
  sprintf("%s · peak %s\ncity − cropland %+.2f °C [%+.2f, %+.2f]%s", reg$region, reg$peak_date, reg$peak_gap,
          reg$peak_ci_lo, reg$peak_ci_hi, ifelse(reg$is_pass, "  ✓", "  ✗")),
  sprintf("%s   not testable%s", reg$region, ifelse(is.na(reg$peak_date) | reg$peak_date == "", " (no cropland)", ""))
)
reg <- reg[order(-ifelse(is.na(reg$peak_gap), -Inf, reg$peak_gap)), ]
verdict <- reg$verdict[1]

# verdict figure
bins$panel <- factor(reg$label[match(bins$region, reg$region)], levels = reg$label)
bins$evi <- bins$evi_bin_lo + 0.01
p1 <- ggplot(bins, aes(evi, mean_lst_c, colour = group)) +
  geom_line(linewidth = 0.4, alpha = 0.6) +
  geom_point(aes(size = n), alpha = 0.85, stroke = 0) +
  facet_wrap(~panel, ncol = 2, scales = "free_y", drop = FALSE) +
  scale_colour_manual(values = c(city = c$warm, cropland = c$accent), name = NULL) +
  scale_size_area(max_size = 4, breaks = c(10, 100, 1000), name = "pixels per bin") +
  guides(size = guide_legend(override.aes = list(colour = c$text))) +
  labs(x = "EVI (0.02 bins, mean of 16 EVI pixels per LST pixel)", y = "Mean daytime land surface temperature (°C)",
       title = sprintf("At each region's greenest-cropland date, are cities hotter than cropland? Verdict: %s", verdict),
       subtitle = "2024 · MODIS IGBP 2024 · pure 1 km LST pixels as units · PASS needs ≥75% of testable regions") +
  theme_wildeye()
ggsave(file.path(out_dir, "s3_season_verdict.png"), p1, width = 11, height = 11, dpi = 150, bg = c$bg)

# curve figure: regions with no testable date (no cropland) are left out, and named in the subtitle
shown <- reg$region[reg$is_testable]
curve <- curve[curve$region %in% shown, ]
curve$region <- factor(curve$region, levels = shown)
gap <- data.frame(region = curve$region, date = curve$date, panel = "city − cropland gap (°C)",
                  y = curve$gap, lo = curve$ci_lo, hi = curve$ci_hi, series = "gap")
evi <- rbind(
  data.frame(region = curve$region, date = curve$date, panel = "median EVI", y = curve$crop_median_evi,
             lo = NA, hi = NA, series = "cropland"),
  data.frame(region = curve$region, date = curve$date, panel = "median EVI", y = curve$city_median_evi,
             lo = NA, hi = NA, series = "city")
)
long <- rbind(gap, evi)
lvl <- as.vector(t(outer(levels(curve$region), c("city − cropland gap (°C)", "median EVI"), paste, sep = " · ")))
fac <- function(d) factor(paste(d$region, d$panel, sep = " · "), levels = lvl)
long$facet <- fac(long)
gap$facet <- fac(gap)
marks <- data.frame(region = factor(shown, levels = shown), peak = as.Date(reg$peak_date[reg$is_testable]))
marks <- rbind(transform(marks, panel = "city − cropland gap (°C)"), transform(marks, panel = "median EVI"))
marks$facet <- fac(marks)
sep <- as.Date("2024-09-13")
p2 <- ggplot(long, aes(date, y)) +
  geom_hline(data = data.frame(facet = factor(lvl[seq(1, length(lvl), 2)], levels = lvl), y = 0), aes(yintercept = y),
             colour = c$text_dim, linewidth = 0.3) +
  geom_ribbon(data = gap, aes(ymin = lo, ymax = hi), fill = c$warm, alpha = 0.25) +
  geom_line(aes(colour = series), linewidth = 0.6, na.rm = TRUE) +
  geom_point(aes(colour = series), size = 0.9, na.rm = TRUE) +
  geom_vline(data = marks, aes(xintercept = peak), colour = c$accent, linewidth = 0.4, na.rm = TRUE) +
  geom_vline(xintercept = sep, colour = c$text_dim, linewidth = 0.4, linetype = "dashed") +
  facet_wrap(~facet, ncol = 2, scales = "free_y", drop = FALSE) +
  scale_colour_manual(values = c(gap = c$warm, cropland = c$accent, city = c$text), name = NULL) +
  scale_x_date(date_breaks = "2 months", date_labels = "%b") +
  labs(x = "2024 (16-day composites)", y = NULL,
       title = "Does the city − cropland heat gap follow the cropland's season?",
       subtitle = sprintf("solid: verdict (peak-greenness) date · dashed: September arm · gap blanked under 30 matched pixels · %s: no cropland",
                          paste(reg$region[!reg$is_testable], collapse = ", "))) +
  theme_wildeye()
ggsave(file.path(out_dir, "s3_season_curve.png"), p2, width = 11, height = 1.9 * nlevels(curve$region) + 1.5, dpi = 150, bg = c$bg)
