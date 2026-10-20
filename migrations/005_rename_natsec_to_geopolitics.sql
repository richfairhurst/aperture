UPDATE evaluations
SET primary_topic = 'geopolitics'
WHERE primary_topic = 'natsec';

UPDATE evaluations
SET probabilities_json = REPLACE(probabilities_json, '"natsec"', '"geopolitics"'),
    raw_response_json = REPLACE(raw_response_json, '"natsec"', '"geopolitics"');
