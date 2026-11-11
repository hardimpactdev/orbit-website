<?php

use Inertia\Testing\AssertableInertia as Assert;

it('renders the homepage with the Home inertia component', function () {
    $this->get('/')
        ->assertSuccessful()
        ->assertSee('<title>Orbit</title>', escape: false)
        ->assertInertia(fn (Assert $page) => $page
            ->component('Home')
        );
});

it('renders the story homepage selected from the Orbit design system', function () {
    $this->get('/')
        ->assertSuccessful()
        ->assertInertia(fn (Assert $page) => $page->component('Home'));

    $source = file_get_contents(resource_path('js/components/orbit/homepage.tsx'));

    expect($source)
        ->toBeString()
        ->toContain('Build ideas faster on machines you own, run by your agent.')
        ->toContain('Local development stops when your laptop does.')
        ->toContain('Move the work. Keep the control.')
        ->toContain('Start with one machine. Make room for what’s next.')
        ->toContain('<Capabilities />')
        ->toContain('<DevelopmentEnvironments />')
        ->toContain('A steady core. Swap the rest.')
        ->toContain('<Install orbitUrl={orbitUrl} />')
        ->toContain('<HeroConstellations />');
});
