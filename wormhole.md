
# Wormhole

## HTTP Server API

### `POST /`

Request body
```javascript
{
    "agent_id": <agent ID>,
    "payload": <entry>
}
```

Respond with signature only
```javascript
res.send( signature );
```
