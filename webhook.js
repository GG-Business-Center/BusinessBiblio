const express = require("express");
const fs = require("fs");

const router = express.Router();

router.post("/paydunya", async (req, res) => {
    const { status, amount, account_alias } = req.body;

    if (status === "completed" && amount === 1000) {
        // Sauvegarder l'utilisateur validé dans client.json
        const clientData = { numero: account_alias, date: new Date().toISOString() };
        let clients = [];

        if (fs.existsSync("client.json")) {
            const existingData = fs.readFileSync("client.json");
            clients = JSON.parse(existingData);
        }

        clients.push(clientData);
        fs.writeFileSync("client.json", JSON.stringify(clients, null, 4));

        return res.json({ success: true, message: "Paiement validé et inscrit !" });
    } else {
        return res.json({ success: false, message: "Paiement non validé ou incorrect." });
    }
});

module.exports = router;
