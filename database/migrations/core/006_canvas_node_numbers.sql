-- Number existing application snapshots without changing IDs, titles or edges.
-- Live collaboration documents are backfilled through their normal Yjs path.
CREATE OR REPLACE FUNCTION pg_temp.number_canvas_nodes(graph jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  item record;
  numbers jsonb := '{}'::jsonb;
  occupied jsonb := '{}'::jsonb;
  slot bigint;
  slot_key text;
BEGIN
  IF jsonb_typeof(graph->'nodes') IS DISTINCT FROM 'array' THEN RETURN graph; END IF;
  -- Reserve all valid existing slots first, including gaps.
  FOR item IN
    SELECT node, ordinal, CASE WHEN node->'data'->>'kind' = 'prompt'
      THEN CASE WHEN node->'data'->>'mediaType' = 'video' THEN 'video_generator' ELSE 'image_generator' END
      ELSE COALESCE(node->'data'->>'kind', 'node') END AS kind
    FROM jsonb_array_elements(graph->'nodes') WITH ORDINALITY AS entries(node, ordinal)
    ORDER BY NULLIF(node->'data'->>'createdAt', '') NULLS LAST, ordinal
  LOOP
    IF jsonb_typeof(item.node->'data'->'nodeNumber') = 'number'
      AND (item.node->'data'->>'nodeNumber') ~ '^[1-9][0-9]{0,14}$'
      AND COALESCE(item.node->'data'->>'nodeNumberType', item.kind) = item.kind THEN
      slot := (item.node->'data'->>'nodeNumber')::bigint;
      slot_key := item.kind || ':' || slot;
      IF NOT occupied ? slot_key THEN
        occupied := occupied || jsonb_build_object(slot_key, true);
        numbers := numbers || jsonb_build_object(item.ordinal::text, slot);
      END IF;
    END IF;
  END LOOP;
  FOR item IN
    SELECT node, ordinal, CASE WHEN node->'data'->>'kind' = 'prompt'
      THEN CASE WHEN node->'data'->>'mediaType' = 'video' THEN 'video_generator' ELSE 'image_generator' END
      ELSE COALESCE(node->'data'->>'kind', 'node') END AS kind
    FROM jsonb_array_elements(graph->'nodes') WITH ORDINALITY AS entries(node, ordinal)
    ORDER BY NULLIF(node->'data'->>'createdAt', '') NULLS LAST, ordinal
  LOOP
    IF NOT numbers ? item.ordinal::text THEN
      slot := 1;
      WHILE occupied ? (item.kind || ':' || slot) LOOP slot := slot + 1; END LOOP;
      occupied := occupied || jsonb_build_object(item.kind || ':' || slot, true);
      numbers := numbers || jsonb_build_object(item.ordinal::text, slot);
    END IF;
    graph := jsonb_set(graph, ARRAY['nodes', (item.ordinal - 1)::text, 'data'],
      (item.node->'data') || jsonb_build_object('nodeNumber', numbers->item.ordinal::text, 'nodeNumberType', item.kind));
  END LOOP;
  RETURN graph;
END;
$$;

UPDATE public.project_snapshots SET graph_json = pg_temp.number_canvas_nodes(graph_json), revision = revision + 1
WHERE graph_json IS DISTINCT FROM pg_temp.number_canvas_nodes(graph_json);
UPDATE public.projects SET graph_json = pg_temp.number_canvas_nodes(graph_json)
WHERE graph_json IS DISTINCT FROM pg_temp.number_canvas_nodes(graph_json);
