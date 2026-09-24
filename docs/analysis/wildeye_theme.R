# wildeye house style for analysis figures: the site's own dark palette (style.css :root).
# Every wildeye plotting script sources this file; restyle here, never inline.
library(ggplot2)

wildeye_colours <- list(
  bg = "#0a0a0f", text = "#e8eaed", text_dim = "#7f8185", grid = "#1c1d24",
  accent = "#00d4ff", warm = "#ffb86b"
)

theme_wildeye <- function(base_size = 11) {
  c <- wildeye_colours
  theme_minimal(base_size = base_size) %+replace%
    theme(
      plot.background = element_rect(fill = c$bg, colour = NA),
      panel.background = element_rect(fill = c$bg, colour = NA),
      panel.grid.major = element_line(colour = c$grid, linewidth = 0.3),
      panel.grid.minor = element_blank(),
      text = element_text(colour = c$text),
      axis.text = element_text(colour = c$text_dim),
      strip.text = element_text(colour = c$text, face = "bold", hjust = 0, margin = margin(4, 0, 4, 0)),
      plot.title = element_text(colour = c$text, face = "bold", hjust = 0, size = base_size * 1.3, margin = margin(0, 0, 4, 0)),
      plot.subtitle = element_text(colour = c$text_dim, hjust = 0, margin = margin(0, 0, 10, 0)),
      legend.position = "top", legend.justification = "left",
      legend.text = element_text(colour = c$text), legend.title = element_text(colour = c$text_dim),
      plot.margin = margin(14, 14, 10, 14)
    )
}
