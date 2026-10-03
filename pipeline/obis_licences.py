"""Licence of every OBIS dataset, from its `intellectualrights` text, by an explicit table.

Spec: docs/superpowers/specs/2026-10-02-obis-grid-design.md. OBIS publishes a dataset's licence only as free text
(api.obis.org/v3/dataset `intellectualrights`; the record-level `license` is mostly empty). Every distinct text, after
collapsing whitespace, was read and classed by hand on 2026-10-02 (44 texts over 6,938 datasets). Only unambiguous
CC0 and plain CC BY count, the bar of the occurrences layer (occurrences.licence_ok) and the effort veil. A text not in
the table raises: a new wording is read before it can put records on the map.
"""

from __future__ import annotations

import re

CC0, CC_BY, OUT = "CC0 1.0", "CC BY 4.0", "out"


class LicenceError(ValueError):
    """An OBIS dataset licence text that has not been classed."""


_CC0_WAIVER = (
    "To the extent possible under law, the publisher has waived all rights to these data and has dedicated them to the "
    "Public Domain (CC0 1.0)"
)
_CANADENSYS = (
    "&amp; http://www.canadensys.net/norms"  # community norms, not licence terms
)

TABLE: dict[str, str] = {
    # CC BY 4.0
    "This work is licensed under a Creative Commons Attribution (CC-BY) 4.0 License": CC_BY,
    "This work is licensed under a Creative Commons Attribution (CC-BY 4.0) License": CC_BY,
    "This work is licensed under a Creative Commons Attribution 4.0 International": CC_BY,
    "This work is released under the Creative Commons Attribution (CC BY) licence": CC_BY,
    "This work is licensed under a http://creativecommons.org/licenses/by/4.0/legalcode": CC_BY,
    "This work is licensed under a Creative Commons Attribution 4.0 International License (CC BY 4.0): "
    "https://creativecommons.org/licenses/by/4.0/.": CC_BY,
    # CC BY plus a pointer to a data policy or norms that ask for citation and add no restriction
    "This work is licensed under a Creative Commons Attribution (CC-BY) 4.0 License ICES Data Policy: "
    "https://www.ices.dk/data/guidelines-and-policy/Pages/ICES-data-policy.aspx": CC_BY,
    "This work is licensed under a Creative Commons Attribution (CC-BY) 4.0 License Release with permission of the "
    "appropriate parties": CC_BY,
    "http://creativecommons.org/licenses/by/4.0/deed.en_US and "
    "http://biodiversity.ku.edu/research/university-kansas-biodiversity-institute-data-publication-and-use-norms": CC_BY,
    "Crown copyright ©. Copyright material on the Protected Species Captures website is protected by copyright owned by "
    "the Ministry for Primary Industries on behalf of the Crown. Unless indicated otherwise for specific items or "
    "collections of content (either below or within specific items or collections), this copyright material is licensed "
    "for re-use under a Creative Commons Attribution (CC-BY) 4.0 License": CC_BY,
    "This information is released under the Creative Commons license - Attribution - CC BY "
    '(https://creativecommons.org/licenses/by/4.0/). The consumer of these data ("Data User" herein) is required to cite '
    "it appropriately in any publication that results from its use. The Data User should realize that these data may be "
    "actively used by others for ongoing research and that coordination may be necessary to prevent duplicate "
    "publication. The Data User is urged to contact the authors of these data if any questions about methodology or "
    "results occur. Where appropriate, the Data User is encouraged to consider collaboration or co-authorship with the "
    "authors. The Data User should realize that misinterpretation of data may occur if used out of context of the "
    "original study. While substantial efforts are made to ensure the accuracy of data and associated documentation, "
    'complete accuracy of data sets cannot be guaranteed. All data are made available "as is." The Data User should be '
    "aware, however, that data are updated periodically and it is the responsibility of the Data User to check for new "
    "versions of the data. The data authors and the repository where these data were obtained shall not be liable for "
    "damages resulting from any use or misinterpretation of the data. Thank you.": CC_BY,
    # CC0 1.0
    _CC0_WAIVER: CC0,
    "This work is licensed under a Public Domain (CC0 1.0)": CC0,
    "This work is licensed under a https://creativecommons.org/publicdomain/zero/1.0/": CC0,
    "cc0": CC0,
    "The data may be used and redistributed for free but is not intended for legal use, since it may contain "
    "inaccuracies. Neither the data Contributor, ERD, NOAA, nor the United States Government, nor any of their employees "
    "or contractors, makes any warranty, express or implied, including warranties of merchantability and fitness for a "
    "particular purpose, or assumes any legal liability for the accuracy, completeness, or usefulness, of this "
    "information. " + _CC0_WAIVER: CC0,
    f"Rights http://creativecommons.org/publicdomain/zero/1.0/ {_CANADENSYS} rights holder: Williamson, Mark": CC0,
    f"rights: http://creativecommons.org/publicdomain/zero/1.0/ {_CANADENSYS} rightsHolder: Northwest Atlantic "
    "Fisheries Organization (NAFO)": CC0,
    f"rights: http://creativecommons.org/publicdomain/zero/1.0/ {_CANADENSYS} rights holder: Scott, David": CC0,
    f"IP rights of this resource http://creativecommons.org/publicdomain/zero/1.0/ {_CANADENSYS} The copyright to the "
    "thesis is held by the University, as per the title page of the thesis.": CC0,
    # out: non-commercial, share-alike, no-derivatives
    "This work is licensed under a Creative Commons Attribution Non Commercial (CC-BY-NC) 4.0 License": OUT,
    "This work is licensed under a Creative Commons Attribution Non Commercial (CC-BY-NC 4.0) License": OUT,
    "This work is licensed under a Creative Commons Attribution-NonCommercial (CC-BY-NC) 4.0 License": OUT,
    # says Non Commercial and CC-BY at once (580 datasets): the restrictive reading wins
    "This work is licensed under a Creative Commons Attribution Non Commercial (CC-BY) 4.0 License": OUT,
    "Attribution-ShareAlike (CC BY-SA)": OUT,
    "Attribution-NonCommercial-ShareAlike (CC BY-NC-SA)": OUT,
    "Attribution-NoDerivatives (CC BY-ND)": OUT,
    "Attribution-NonCommercial-NoDerivatives (CC BY-NC-ND)": OUT,
    # out: open licences other than CC0 / CC BY (not the project's bar)
    "This [DATA(BASE)-NAME] is made available under the Open Data Commons Attribution License: "
    "http://www.opendatacommons.org/licenses/by/1.0/.": OUT,
    "This dataset [MNA (Section of Genoa) and NIWA Invertebrate Collection - Ross Sea Tanaidacea] is made available "
    "under the Open Data Commons Attribution Licences: http://opendatacommons.org/licenses/by/1.0/": OUT,
    f"rights: http://data.gc.ca/eng/open-government-licence-canada {_CANADENSYS} rights holder: Her Majesty the Queen "
    "in right of Canada, as represented by the Minister of Fisheries and Oceans": OUT,
    f"rights: http://data.gc.ca/eng/open-government-licence-canada {_CANADENSYS} rights holder: Her Majesty the Queen "
    "in right of Canada, as represented by the Minister of Natural Resources Canada": OUT,
    f"rights: 'http://data.gc.ca/eng/open-government-licence-canada {_CANADENSYS} rightsholder: 'Her Majesty the Queen "
    "in right of Canada, as represented by the Minister of Natural Resources Canada'": OUT,
    f"rights: 'http://data.gc.ca/eng/open-government-licence-canada {_CANADENSYS} rightsholder: 'Her Majesty the Queen "
    "in right of Canada, as represented by the Minister of Fisheries and Oceans'": OUT,
    # out: no licence named, or restricted
    "": OUT,
    "Licence": OUT,
    "Unknown": OUT,
    "Unrestricted": OUT,
    "Unrestricted after moratorium period": OUT,
    "Restricted": OUT,
    "For more information on the restrictions, use contact information.": OUT,
    # the CC0 waiver cut off before the licence is named
    "To the extent possible under law, the publisher has waived all rights to these data and has dedicated them to the": OUT,
    "Namdeb Diamond Corporation kindly allowed the data to be made public. The data are and remain property of Namdeb "
    "Diamond Corporation. Rutgers University retains permanent rights to make the data publicly available. The "
    "scientists involved in the collection of these datasets should be acknowledged, and a citation to the dataset "
    "(similar to the one suggested in this metadata record) should be included in any analysis or other work that makes "
    "substantial use of these data.": OUT,
    "De Beers Marine Namibia kindly allowed the data to be made public. The data are and remain property of De Beers "
    "Marine Namibia. The scientists involved in the collection of these datasets should be acknowledged, and a citation "
    "to the dataset (similar to the one suggested in this metadata record) should be included in any analysis or other "
    "work that makes substantial use of these data.": OUT,
}


def normalise(text: str | None) -> str:
    """Whitespace collapsed and trimmed: OBIS serves the same wording with different runs of spaces and newlines."""
    return re.sub(r"\s+", " ", text or "").strip()


def licence(text: str | None) -> str:
    """CC0, CC_BY or OUT for one dataset's intellectualrights; LicenceError for a text the table does not hold."""
    key = normalise(text)
    try:
        return TABLE[key]
    except KeyError:
        raise LicenceError(
            f"OBIS licence text not classed (add it to obis_licences.TABLE after reading it): {key!r}"
        ) from None
