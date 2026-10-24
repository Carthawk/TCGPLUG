# The TCG Plug – koppeling

Dit programma zet betaalde bestellingen uit Shopify (TikTok én webshop) automatisch in de wachtrij van het kluis-dashboard, toont de TikTok live-chat en print labels op de Dymo.

## Eenmalig instellen

1. **Node.js installeren.** Download de LTS-versie van https://nodejs.org en installeer met de standaardinstellingen.
2. **DYMO Connect installeren** via https://www.dymo.com/online-support.html, en daarna pas de Dymo met USB aansluiten.
3. **Deze map uitpakken**, bijvoorbeeld op het bureaublad van de stream-pc.
4. **Een Shopify-app aanmaken** (alleen leesrechten voor bestellingen):
   - Log in op Shopify en open via je profielmenu het **Dev Dashboard** (of ga naar https://dev.shopify.com/dashboard).
   - Maak een nieuwe app aan, bijvoorbeeld "TCG Plug wachtrij".
   - Kies bij de API-rechten (scopes) **read_orders** en **read_customers**, en vraag toegang tot **beschermde klantgegevens: naam**. Sla op en publiceer (release) de versie.
   - Installeer de app op de winkel.
   - Kopieer bij de instellingen van de app de **Client ID** en het **Client Secret**.
5. **Programma starten:** dubbelklik op `start.bat` (Windows) of `start.command` (Mac).
6. **Instellingen invullen** op http://localhost:3000/setup: winkelnaam (het stuk vóór `.myshopify.com`), Client ID, Client Secret en de TikTok-gebruikersnaam van de stream. Klik op *Opslaan*. Bovenaan moet daarna **Shopify verbonden** staan.
7. **Testen:** open het dashboard (http://localhost:3000) en klik op de instellingenpagina op *Testbestelling sturen* en *Testlabel printen*.

## Snelkoppeling op het bureaublad

Dubbelklik één keer op **Snelkoppeling maken.bat**. Er verschijnt dan op het bureaublad een icoon **The TCG Plug** met het logo. Daarmee start je voortaan het programma; het zwarte venster opent dan geminimaliseerd onderin de taakbalk (laat het open staan) en het dashboard opent vanzelf.

Verplaats de map met het programma niet meer nadat je de snelkoppeling hebt gemaakt. Doe je dat toch, dubbelklik dan opnieuw op *Snelkoppeling maken.bat*.

## Tijdens de stream

- Dubbelklik op `start.bat` en **laat het zwarte venster open**. Het dashboard opent vanzelf in een eigen venster.
- Gebruik dat venster (of http://localhost:3000) op de stream, bijvoorbeeld in OBS via vensteropname.
- Rechtsboven staat of Shopify verbonden is. Die melding verdwijnt in presentatiemodus.
- Alleen **betaalde** bestellingen komen in de rij. Elke bestelling komt er maar één keer in, ook als je het programma herstart.
- Bestellingen die binnenkomen terwijl het dashboard dicht is, verschijnen zodra je het opent.

## Live chat

Naast de kluis en de wachtrij staat een derde kolom met de live-chat van TikTok. Die blijft ook in presentatiemodus in beeld, zodat de streamer alles vanuit één scherm ziet.

- Bovenaan staat **👋 Net binnen**: de laatste tien kijkers die de live binnenkwamen, handig om ze te verwelkomen.
- Daaronder komen reacties, gifts (🎁), nieuwe volgers (⭐) en shares binnen.
- Klik op een naam om die meteen in het klantnaam-veld van de wachtrij te zetten.
- Met **💬 Chat** rechtsboven klap je de kolom in of uit.
- De chat werkt zodra de TikTok-gebruikersnaam is ingevuld op de instellingenpagina en de stream live is. Is de stream nog niet live, dan probeert het programma het elke minuut opnieuw.
- Op de instellingenpagina staat een knop *Testchat sturen* om het te proberen zonder live te zijn.

## Labels printen

Bij het afronden van een klant (*Volgende klant* of *Klant klaar*) print het programma automatisch een label met de naam van de klant, wat hij gekocht heeft, de datum en een volgnummer. Het label is gemaakt voor **Dymo 11352 (54 × 25 mm)**.

- De labels gaan **rechtstreeks via DYMO Connect** naar de Dymo. Er verschijnt geen printvenster en de printer hoeft niet in de printerlijst van Windows te staan. DYMO Connect moet wel geïnstalleerd zijn; openen is niet nodig.
- Zet in het dashboard bij **⚙︎ Instellingen** het vinkje **Label printen bij afronden** aan.
- Op de instellingenpagina (http://localhost:3000/setup) zie je onder **Labelprinter (Dymo)** welke Dymo het programma gevonden heeft, en kun je een **testlabel** printen.
- Lukt printen via DYMO Connect niet, dan valt het dashboard terug op het gewone printvenster van de browser.

## Namen van kopers

Alle bestellingen komen uit Shopify, ook die van TikTok. In de wachtrij staat per bestelling:

- **Voornaam en bestelnummer**, bijvoorbeeld *Sanne · #1042*. Geeft Shopify geen voornaam mee, dan staat er *Bestelling #1042*.
- **Wat er besteld is**, eronder.
- Een icoontje voor waar de bestelling vandaan komt: 🛒 = via TikTok, 🛍️ = via de webshop.

Standaard komen alleen **TikTok-bestellingen** in de rij: bestellingen via het TikTok-kanaal, of webshop-bestellingen waarbij de klant voor TikTok heeft gekozen. Bestellingen voor **Whatnot** worden overgeslagen; in het zwarte venster zie je welke. Dit kun je op de instellingenpagina veranderen bij *Welke bestellingen in de wachtrij?*

Alleen **betaalde** bestellingen komen in de rij, en elke bestelling maar één keer. Op het label staan dezelfde naam en hetzelfde bestelnummer, handig bij het inpakken.

## Korte productnamen

TikTok-productnamen zijn vaak lang. Op de instellingenpagina kun je per regel een vertaling opgeven, bijvoorbeeld:

```
Booster Bundle = 30th Celebration bundel
Blister = 30th Celebration blister
```

## Kluisstand altijd bewaard

De stand van de kluis (packs, waarde), de wachtrij en de vaste klanten worden bij elke wijziging opgeslagen in `data/dashboard.json` op de pc.

- Sluit je het dashboard, herstart je de pc of werk je het programma bij: alles staat er weer precies zo.
- Heb je het dashboard in meerdere vensters open (bijvoorbeeld één voor OBS en één om te bedienen), dan lopen die automatisch gelijk.
- Elke wijziging van het aantal packs of de waarde per pack komt in `data/kluis-logboek.jsonl`, met tijd en totaalbedrag. Zo kun je altijd terugzien hoe de kluis gegroeid is.

## Updates

Het programma kan zichzelf bijwerken.

- Bij het opstarten kijkt het of er een nieuwe versie is. Zo ja, dan staat dat in het zwarte venster.
- Ga naar http://localhost:3000/setup en klik onder **Updates** op **Bijwerken**. Het programma downloadt de nieuwe versie, controleert of alles goed binnen is, maakt een reservekopie van de oude versie (map `reservekopie`) en start daarna vanzelf opnieuw.
- De map `data`, met de instellingen en sleutels, wordt nooit aangeraakt.
- Bijwerken liever niet midden in een stream doen; het herstarten duurt een paar seconden.

## Let op

- In de map `data` staan je sleutels. **Deel die map met niemand.**
- Het dashboard op localhost heeft een eigen geheugen, los van de online versie. Vaste klanten en producten bouw je hier dus opnieuw op.
- Gaat er iets mis, dan staat de foutmelding in het zwarte venster. Stuur die tekst door, dan is het snel opgelost.
