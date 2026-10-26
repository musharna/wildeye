# AEF change pilot (docs/analysis/aef-change-pilot.md), two figures from aef_change_cells.tsv.gz:
#   aef_change_pilot.png    the 12 tiles the score was chosen on: raw 2024→25 distance, the frozen score, Hansen 2025 loss
#   aef_change_holdout.png  the 14 held-out tiles: the score one year earlier (2024), the score for 2025, Hansen 2025 loss
# Run from the repo root: Rscript docs/analysis/aef_change_figure.R
source("docs/analysis/wildeye_theme.R")

cells <- read.delim("docs/analysis/aef_change_cells.tsv.gz", na.strings = "NA")
threshold <- jsonlite::fromJSON("docs/analysis/aef_change_pilot.json")$threshold
cap <- function(x) pmin(pmax(x, 0), 2 * threshold)

tiles <- function(set, panels, title, file) {
  t <- cells[cells$set == set, ]
  long <- do.call(rbind, lapply(names(panels), function(p) data.frame(t[c("region", "row", "col")], panel = p, v = panels[[p]](t))))
  long$panel <- factor(long$panel, levels = names(panels))
  long$region <- factor(long$region, levels = unique(t$region))
  p <- ggplot(long, aes(col, -row, fill = v)) + geom_raster() + coord_equal() + facet_grid(region ~ panel, switch = "y") +
    scale_fill_viridis_c(option = "magma", limits = c(0, 2 * threshold), na.value = "grey30",
                         name = "score", breaks = c(0, threshold, 2 * threshold),
                         labels = c("0", sprintf("%.1f flag", threshold), sprintf("≥%.0f", 2 * threshold))) +
    labs(title = title, subtitle = "82 km tiles, 1.28 km cells, north up; grey = no data") +
    theme_wildeye(9) + theme(axis.text = element_blank(), axis.title = element_blank(), panel.grid = element_blank(),
                             strip.text.y.left = element_text(angle = 0, hjust = 1))
  ggsave(file, p, width = 6.5, height = 1.55 * length(unique(t$region)) + 1.2, dpi = 100, bg = wildeye_colours$bg)
}

loss <- function(t) 2 * threshold * t$loss25
tiles("pilot", list("raw distance ×100" = function(t) cap(100 * t$d2425), "score 2025" = function(t) cap(t$zn25),
                    "loss 2025" = loss),
      "Pilot tiles: the score was chosen here", "docs/analysis/aef_change_pilot.png")
tiles("holdout", list("score 2024" = function(t) cap(t$zn24), "score 2025" = function(t) cap(t$zn25), "loss 2025" = loss),
      "Held-out tiles: frozen score and threshold", "docs/analysis/aef_change_holdout.png")
