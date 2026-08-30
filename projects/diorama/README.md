# Diorama stills

PNG stills are the product. 1:1 day/night clay pairs. No UI chrome on the images.

Drop files in `stills/` using this name scheme:

    stills/diorama-<slug>-day.png
    stills/diorama-<slug>-night.png

Then list them in `stills.json` (array of places; one carousel slot per slug):

    [
      {
        "slug": "ushi",
        "title": "Place name",
        "day": "stills/diorama-ushi-day.png",
        "night": "stills/diorama-ushi-night.png"
      }
    ]

If `day` / `night` are omitted, paths are inferred from `slug` with the same pattern.
Empty array ships as the v1 void. Do not invent a first scene.

Optional later: add `"glb": "stills/diorama-<slug>.glb"` to render a model in that slot.
