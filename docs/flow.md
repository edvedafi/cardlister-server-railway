There are two flows to consider. The first is how a new listing gets created, and the second is what happens when a card
sells.

# New Listing Flow

### Deploy the MedusaJS backend.

1. Details of all of this will be covered elsewhere.
2. Add the backend URL to the frontend's `.env` file.

### Gather Pictures and quantities with the local script

1. Take pictures of cards. Note they must be in alphabetical order: front1, back1, front2, back2, etc.
2. Run `yarn start` in the scripts-frontend directory of the project.
    1. There are lots of ways to tell this program where your images are, run `yarn start --help` to see them.
3. Select the set you want to add a listing for.
    1. Note if this is a new set follow the steps to build the set.
    2. Set data is built locally and then sent to the MedusaJS backend as ProductCategories and Products respectively.
    3. Data is collected from BSC and SportLots to ensure that the set can be looked up in their systems.
        1. Will need to add logic to this for every site that lists by set. Sites that list by card do not need this.
4. HuggingFace is used to process the images and determine which card from the set the image is.
    1. Prompts ensure all of the information the AI determined is accurate:
    2. Identify the card number/player to link it to the card in the set.
    3. Confirm trimming the image properly found the card and cropped out the background and rotated the card to a
       perfect vertical alignment.
    4. Ensure attributes identified: print run, RC, Jersey, Auto, etc. are correct.
5. Enter the quantity of the card and price for each website.
6. At this point the script will store the image on Firebase Storage and send the rest of the information to MedusaJS.
7. Add any bulk cards, these are the 18 cent cards on SportLots that do no get pictures.
8. The last step is in the script is to request MedusaJS to run a sync of this category.
9. The MedusaJS backend will then sync the cards to the sites.
10. Log when all the syncs are complete, usually 2-3 minutes for a full sized set.

### MedusaJS Backend for Syncing Cards to sites

The flow here is the [AbstractListingStrategy](../medusajs-backend/src/strategies/AbstractListingStrategy.ts) Flow.
Please see each individual site for specifics on how to sync cards to
that site. Note anything that says query or save to database is referencing the MedusaJS system directly. Anything that
says `ListingSite` is referencing the webstie that we are listing cards on.

1. The BatchRequest will tell us the set we need to sync.
2. Query all of the Products in the set.
3. Get the Location/Region information that identifies the ListingSite.
4. If there is no information for 2 or 3 above then exit immediately.
5. Login to the ListingSite.
6. Remove all inventory for this set on the ListingSite.
    * Note this is only relevant for ListingSites that are Set based, not listing sites that are Card based.
7. Run the syncProducts function
    * Set based ListingSites this needs to be managed at this level by the ListingSite Adapter
    * Card based sites continue on. With a loop through ProductVariants:

    1. Get the price and images urls for the ProductVariant.
        * Check with the ListingSite Adapter to ensure the ProductVariant belongs listed on the ListingSite.
        * If the adapter sets `requireImages` = true then products without images will be skipped
        * If the adapter sets `minPrice` = n then products with a price below n will be skipped
    2. Assuming all criteria for listing are met call the abstract function syncProduct to list the card on the
       ListingSite
    3. If the ListSite Adapter returns `platformMetadata` with a successful response save it to the database.
8. Return a summary of all of the cards that were listed including count, errors and metadata.

##### Current Sites

* [MyCardPost](mcp.md)
* [Ebay](ebay.md)
* [SportLots](sportlots.md)
* [BuySportsCards](bsc.md)
* [MySlabs](myslabs.md)

##### Potential future sites:

* [comc.md](comc.md)
* [tcg.md](tcg.md)
* [cardmarket.md](cardmarket.md)
* [stockx.md](stockx.md)
* [starstock.md](starstock.md)
* [pwcc.md](pwcc.md)
* [golden.md](golden.md)
* [probstein.md](probstein.md)
* [lcs.md](lcs.md)
* [facebook.md](facebook.md)
* [instagram.md](instagram.md)
* [tiktok.md](tiktok.md)
* [twitter.md](twitter.md)
* [discord.md](discord.md)
* [twitch.md](twitch.md)
* [youtube.md](youtube.md)
* [reddit.md](reddit.md)
* [craigslist.md](craigslist.md)
* [offerup.md](offerup.md)
* [letgo.md](letgo.md)
* [mercari.md](mercari.md)
* [poshmark.md](poshmark.md)
* [mycard.md](mycard.md)
* [shopify.md](shopify.md)