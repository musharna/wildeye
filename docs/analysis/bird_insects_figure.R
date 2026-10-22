# Airspeed check (docs/analysis/bird-insects.md), two figures from bird_insects.json:
#   bird_insects.png        per radar and night, the share of the night's density moving under the cutoff through
#                           the air (insect-like); the nights asked about and the bird controls outlined.
#   bird_insects_quiet.png  that share against the night's bird count (mt): insect-like nights are the quiet ones.
# Run from the repo root: Rscript docs/analysis/bird_insects_figure.R
source("docs/analysis/wildeye_theme.R")

doc <- jsonlite::fromJSON("docs/analysis/bird_insects.json", simplifyVector = FALSE)
sites <- jsonlite::fromJSON("pipeline/sites.json")
num <- function(x) if (is.null(x)) NA_real_ else x
rows <- do.call(rbind, lapply(names(doc$nights), function(s) do.call(rbind, lapply(names(doc$nights[[s]]), function(n) {
  r <- doc$nights[[s]][[n]]
  data.frame(site = s, night = as.Date(n), share = num(r$insect_share), mt = num(r$mt_birds_km),
             verdict = if (is.null(r$verdict)) "no scans" else r$verdict)
}))))
rows$site <- factor(rows$site, levels = sites$id[order(sites$lat)])
keyed <- function(keys) {
  k <- do.call(rbind, strsplit(unlist(keys), " "))
  data.frame(site = factor(k[, 1], levels = levels(rows$site)), night = as.Date(k[, 2]))
}
asked <- keyed(doc$controls$asked)
ctrl <- keyed(names(doc$controls$bird_controls))
judged <- rows[rows$verdict %in% c("birds", "insects"), ]
n_ins <- sum(judged$verdict == "insects")
cut <- doc$rules$cutoff_ms

c <- wildeye_colours
p <- ggplot(rows, aes(night, site)) +
  geom_tile(aes(fill = share), colour = c$bg, linewidth = 0.4) +
  geom_tile(data = rows[!rows$verdict %in% c("birds", "insects"), ], fill = c$grid, colour = c$bg, linewidth = 0.4) +
  geom_tile(data = asked, fill = NA, colour = c$accent, linewidth = 1.1) +
  geom_tile(data = ctrl, fill = NA, colour = "#ffffff", linewidth = 1.1) +
  scale_fill_gradient(low = "#15161d", high = c$warm, limits = c(0, 1), na.value = c$grid,
                      name = sprintf("share of density under %g m/s through the air", cut)) +
  scale_x_date(date_breaks = "3 days", date_labels = "%b %d", expand = c(0, 0)) +
  labs(x = NULL, y = NULL,
       title = sprintf("Airspeed check: %d of %d radar-nights read insects (≥ %g%% of density under %g m/s)",
                       n_ins, nrow(judged), 100 * doc$rules$insect_share, cut),
       subtitle = sprintf(paste0("Wind: NOAA RAP 1000-600 hPa, %.1f m/s RMS against radiosondes (%d levels). ",
                                 "Radars south to north.\nBlue: the nights asked about. White: bird controls. Grey: no scans or no wind."),
                          doc$raob$rms_ms$turned, doc$raob$levels_compared)) +
  theme_wildeye() + theme(panel.grid.major = element_blank(), legend.key.width = unit(2, "cm"))
ggsave("docs/analysis/bird_insects.png", p, width = 11, height = 6.4, dpi = 150, bg = c$bg)

judged$asked <- paste(judged$site, judged$night) %in% unlist(doc$controls$asked)
judged <- judged[is.finite(judged$mt) & judged$mt > 0, ]
share_ins <- sum(judged$mt[judged$verdict == "insects"]) / sum(judged$mt)
q <- ggplot(judged, aes(mt, share)) +
  geom_hline(yintercept = doc$rules$insect_share, colour = c$text_dim, linetype = "dashed", linewidth = 0.4) +
  geom_point(data = judged[!judged$asked, ], colour = c$warm, alpha = 0.55, size = 1.6) +
  geom_point(data = judged[judged$asked, ], colour = c$accent, size = 3) +
  geom_text(data = judged[judged$asked, ], aes(label = paste(site, format(night, "%b %d"))), colour = c$accent,
            hjust = 1.1, vjust = -0.6, size = 3) +
  scale_x_log10(breaks = 10^(0:6), labels = scales::label_number(scale_cut = scales::cut_short_scale())) +
  scale_y_continuous(limits = c(0, 1)) +
  labs(x = "Birds counted that night (migration traffic, birds/km, log scale)",
       y = sprintf("Share of density under %g m/s", cut),
       title = sprintf("Insect-like nights are the quiet ones: they hold %.0f%% of the birds counted", 100 * share_ins),
       subtitle = sprintf("%d radar-nights, 20 radars, 27 Sep-20 Oct 2026. Above the dashed line a night reads insects.\nBlue: the nights asked about.",
                          nrow(judged))) +
  theme_wildeye()
ggsave("docs/analysis/bird_insects_quiet.png", q, width = 10, height = 5.5, dpi = 150, bg = c$bg)
