# My Card Post Adapter

## Overview

MyCardPost.com is a per card listing website. The site uses a no listing/selling fee structure, so more listings is a
good thing. It does require Images for All Listings and a minimum Price of $1 per listing.

## Syncing Cards

1. Assumes all steps have been run to start a proper sync of a set. See [flow.md](flow.md) for more details.
2. Login to MyCardPost.com [^1]
    1. Use Axios to make a get request to https://mycardpost.com/login
    2. Store the cookies in a [CookieJar](https://www.npmjs.com/package/cookiejar) for all future requests.
    3. Use Axios to make a post request to https://mycardpost.com/login with the following form data for
       email/password/token
3. Loop through all the ProductVariants in the set.
    1. Verify ProductVariant is listable:
        1. Must have an Image
        2. Must be >= $1
        3. If either of the above are false return `{skipped: true}`.
    2. If the quantity is > 1
        1. If I have an mcpID in the database [^2]
            1. Use Axios to make a get request to https://mycardpost.com/card-details/{mcpID}
            2. If this returns success then return `{skipped: true}` and move onto the next card
            3. If this returns a 404 then delete the mcpID that is stored and treat as a new listing
        2. If I do not have an mcpID in the database
            1. Build the FormData object that would mimic the form on the https://mycardpost.com/add-card page.
            2. Only notable fields are `front_image_url` and `back_image_url` are set to URLs of images hosted in
               Firebase.
            3. The rest o teh fields are just typical text fields.
            4. Use Axios to make a post request to https://mycardpost.com/add-card with the FormData object.
            5. Now obtain the mcpID.
                1. This value is not returned from `add-card` so instead use Axios to make a get request
                   to https://mycardpost.com/edvedafi?tab=shop.
                2. This call returns the HTML for the page so leverage DOMParser to locally read the HTML and find the
                   of the `card-details` link under the first div with a `.card-blk` class.
            6. Save the mcpID to the database.
        3. return `{quantity: 1}` because the above will always list only one copy of the card even if I have more than
           one.
    3. If the quantity is 0
        1. If there is an mcpID in the database
        2. Use Axios to make a get request to https://mycardpost.com/delete-card/{mcpID}
        3. Delete the mcpID from the database.
4. Return a summary of all the cards that were listed including count, errors and metadata.[^3]

[^1] This method calls log in once per set sync. That will happen each time a new set is listed. Occasionally I could
list multiple sets in a row so I may be able to cache that token for a while but unsure how I would know when it
expires, which means more error calls and given the way I list I think I would have more cache misses than hits.

[^2] I really have this check as a safty net for erronous data to ensure my calls are always idempotent. I could
probably remove this check and just always assume if I have an mcpID stored then I have a listing and skip it.

[^3] There is no call to logout, I can certainly add that here as I have no reason not to log out.  
